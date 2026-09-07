use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::store::{append_audit, iso8601, resolve_work_item};
use super::{
    PropertyDefinition, PropertyType, SetWorkItemPropertyValueRequest, SyncedWorkItemPropertyValue,
    TypedPropertyWireSnapshot, UpsertPropertyDefinitionRequest, WorkItemPropertyValue,
    WorkItemScope,
};
use crate::projects::io::helpers::{conn, now_ms};

const MAX_PROPERTY_NAME_CHARS: usize = 80;
const MAX_TEXT_CHARS: usize = 20_000;
const ORG_SCOPE_MISMATCH: &str = "PM_ERR:ORG_SCOPE_MISMATCH";
const PROPERTY_MEMBER_INVALID: &str = "PM_ERR:PROPERTY_MEMBER_INVALID";

fn member_reference_id(value: &str) -> Option<&str> {
    value
        .strip_prefix("member:")
        .filter(|member_id| !member_id.trim().is_empty() && member_id.trim() == *member_id)
}

fn org_scope_mismatch(entity: &str, id: &str) -> String {
    format!("{ORG_SCOPE_MISMATCH}:{entity}:{id}")
}

fn decode_definition(row: &rusqlite::Row<'_>) -> rusqlite::Result<PropertyDefinition> {
    let property_type: String = row.get(3)?;
    let config_json: String = row.get(5)?;
    Ok(PropertyDefinition {
        id: row.get(0)?,
        org_id: row.get(1)?,
        name: row.get(2)?,
        property_type: PropertyType::try_from(property_type.as_str()).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                std::io::Error::new(std::io::ErrorKind::InvalidData, err).into(),
            )
        })?,
        description: row.get(4)?,
        config: serde_json::from_str(&config_json).unwrap_or_default(),
        position: row.get(6)?,
        archived_at: row.get::<_, Option<i64>>(7)?.map(iso8601),
        created_at: iso8601(row.get(8)?),
        updated_at: iso8601(row.get(9)?),
    })
}

fn find_definition(
    connection: &Connection,
    property_id: &str,
) -> Result<Option<PropertyDefinition>, String> {
    connection
        .query_row(
            "SELECT id, org_id, name, property_type, description, config_json,
                    position, archived_at, created_at, updated_at
               FROM pm_property_definitions WHERE id = ?1",
            params![property_id],
            decode_definition,
        )
        .optional()
        .map_err(|err| format!("typed property store: {err}"))
}

fn read_definition(
    connection: &Connection,
    property_id: &str,
) -> Result<PropertyDefinition, String> {
    find_definition(connection, property_id)?
        .ok_or_else(|| format!("Property definition '{property_id}' not found"))
}

fn validate_definition_type_change(
    connection: &Connection,
    property_id: &str,
    stored_type: &str,
    requested_type: PropertyType,
) -> Result<(), String> {
    if stored_type == requested_type.as_str() {
        return Ok(());
    }
    let value_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_property_values WHERE property_id = ?1",
            params![property_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("typed property store: {err}"))?;
    if value_count > 0 {
        return Err(
            "A property type cannot change after Work Items have values; archive it and create a new property"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_definition_fields(
    name: &str,
    property_type: PropertyType,
    config: &super::PropertyConfig,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_PROPERTY_NAME_CHARS {
        return Err(format!(
            "Property name must contain 1-{MAX_PROPERTY_NAME_CHARS} characters"
        ));
    }
    if matches!(
        property_type,
        PropertyType::Select | PropertyType::MultiSelect
    ) {
        if config.options.is_empty() {
            return Err("Select properties require at least one option".to_string());
        }
        let mut ids = BTreeSet::new();
        for option in &config.options {
            if option.id.trim().is_empty() || option.name.trim().is_empty() {
                return Err("Property option id and name are required".to_string());
            }
            if !ids.insert(option.id.trim()) {
                return Err(format!("Duplicate property option id '{}'", option.id));
            }
        }
    } else if !config.options.is_empty() {
        return Err("Only select properties may define options".to_string());
    }
    Ok(name.to_string())
}

pub(crate) fn upsert_definition(
    request: UpsertPropertyDefinitionRequest,
) -> Result<PropertyDefinition, String> {
    let name = validate_definition_fields(&request.name, request.property_type, &request.config)?;
    if request.org_id.trim().is_empty() {
        return Err("orgId is required".to_string());
    }
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("typed property tx: {err}"))?;
    let id = request
        .id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("prop_{}", uuid::Uuid::new_v4().simple()));
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT org_id, property_type FROM pm_property_definitions WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("typed property store: {err}"))?;
    if existing
        .as_ref()
        .is_some_and(|(stored_org, _)| stored_org != &request.org_id)
    {
        return Err(org_scope_mismatch("property_definition", &id));
    }
    if let Some((_, stored_type)) = &existing {
        validate_definition_type_change(&tx, &id, stored_type, request.property_type)?;
    }
    let config_json = serde_json::to_string(&request.config)
        .map_err(|err| format!("typed property config serialization: {err}"))?;
    let now = now_ms();
    tx.execute(
        "INSERT INTO pm_property_definitions (
             id, org_id, name, property_type, description, config_json,
             position, archived_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             property_type = excluded.property_type,
             description = excluded.description,
             config_json = excluded.config_json,
             position = excluded.position,
             archived_at = NULL,
             updated_at = excluded.updated_at
         WHERE pm_property_definitions.org_id = excluded.org_id",
        params![
            id,
            request.org_id,
            name,
            request.property_type.as_str(),
            request.description,
            config_json,
            request.position,
            now
        ],
    )
    .map_err(|err| format!("typed property store: {err}"))?;
    crate::sync::collab_bridge::record_property_definitions_touch(&tx, &request.org_id, &id)?;
    let definition = read_definition(&tx, &id)?;
    tx.commit()
        .map_err(|err| format!("typed property commit: {err}"))?;
    Ok(definition)
}

pub(crate) fn list_definitions(
    org_id: &str,
    include_archived: bool,
) -> Result<Vec<PropertyDefinition>, String> {
    let connection = conn()?;
    let archived_predicate = if include_archived {
        ""
    } else {
        "AND archived_at IS NULL"
    };
    let sql = format!(
        "SELECT id, org_id, name, property_type, description, config_json,
                position, archived_at, created_at, updated_at
           FROM pm_property_definitions
          WHERE org_id = ?1 {archived_predicate}
          ORDER BY position ASC, created_at ASC, id ASC"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|err| format!("typed property store: {err}"))?;
    let definitions = statement
        .query_map(params![org_id], decode_definition)
        .map_err(|err| format!("typed property store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("typed property store: {err}"))?;
    Ok(definitions)
}

pub(crate) fn archive_definition(property_id: &str) -> Result<PropertyDefinition, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("typed property tx: {err}"))?;
    let now = now_ms();
    let changed = tx
        .execute(
            "UPDATE pm_property_definitions
                SET archived_at = COALESCE(archived_at, ?2), updated_at = ?2
              WHERE id = ?1",
            params![property_id, now],
        )
        .map_err(|err| format!("typed property store: {err}"))?;
    if changed != 1 {
        return Err(format!("Property definition '{property_id}' not found"));
    }
    let definition = read_definition(&tx, property_id)?;
    crate::sync::collab_bridge::record_property_definitions_touch(
        &tx,
        &definition.org_id,
        property_id,
    )?;
    tx.commit()
        .map_err(|err| format!("typed property commit: {err}"))?;
    Ok(definition)
}

fn validate_value(
    definition: &PropertyDefinition,
    value: &serde_json::Value,
) -> Result<(), String> {
    let invalid =
        |expected: &str| Err(format!("Property '{}' expects {expected}", definition.name));
    match definition.property_type {
        PropertyType::Text => {
            let Some(text) = value.as_str() else {
                return invalid("text");
            };
            if text.chars().count() > MAX_TEXT_CHARS {
                return Err(format!(
                    "Text properties are limited to {MAX_TEXT_CHARS} characters"
                ));
            }
        }
        PropertyType::Number => {
            let Some(number) = value.as_f64() else {
                return invalid("a number");
            };
            if !number.is_finite() {
                return invalid("a finite number");
            }
        }
        PropertyType::Select => {
            let Some(option_id) = value.as_str() else {
                return invalid("one option id");
            };
            if !definition
                .config
                .options
                .iter()
                .any(|option| option.id == option_id)
            {
                return Err(format!(
                    "Unknown option '{option_id}' for '{}'",
                    definition.name
                ));
            }
        }
        PropertyType::MultiSelect => {
            let Some(values) = value.as_array() else {
                return invalid("an array of option ids");
            };
            let allowed = definition
                .config
                .options
                .iter()
                .map(|option| option.id.as_str())
                .collect::<BTreeSet<_>>();
            let mut seen = BTreeSet::new();
            for item in values {
                let Some(option_id) = item.as_str() else {
                    return invalid("an array of option ids");
                };
                if !allowed.contains(option_id) {
                    return Err(format!(
                        "Unknown option '{option_id}' for '{}'",
                        definition.name
                    ));
                }
                if !seen.insert(option_id) {
                    return Err(format!(
                        "Duplicate option '{option_id}' for '{}'",
                        definition.name
                    ));
                }
            }
        }
        PropertyType::Date => {
            let Some(date) = value.as_str() else {
                return invalid("an ISO date");
            };
            if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
                && chrono::DateTime::parse_from_rfc3339(date).is_err()
            {
                return invalid("an ISO date or timestamp");
            }
        }
        PropertyType::Checkbox => {
            if !value.is_boolean() {
                return invalid("true or false");
            }
        }
        PropertyType::Url => {
            let Some(raw) = value.as_str() else {
                return invalid("an http(s) URL");
            };
            let url = reqwest::Url::parse(raw)
                .map_err(|_| format!("Property '{}' expects an http(s) URL", definition.name))?;
            if !matches!(url.scheme(), "http" | "https") {
                return invalid("an http(s) URL");
            }
        }
        PropertyType::Actor => {
            let Some(actor) = value.as_str() else {
                return invalid("a member reference");
            };
            if member_reference_id(actor).is_none() {
                return invalid("a member reference in the form member:<id>");
            }
        }
        PropertyType::MultiActor => {
            let Some(values) = value.as_array() else {
                return invalid("an array of member references");
            };
            let mut seen = BTreeSet::new();
            for item in values {
                let Some(actor) = item.as_str() else {
                    return invalid("an array of member references");
                };
                if member_reference_id(actor).is_none() {
                    return invalid("member references in the form member:<id>");
                }
                if !seen.insert(actor) {
                    return Err(format!(
                        "Duplicate member reference '{actor}' for '{}'",
                        definition.name
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_member_ownership(
    connection: &Connection,
    definition: &PropertyDefinition,
    value: &serde_json::Value,
    org_id: &str,
    project_slug: Option<&str>,
) -> Result<(), String> {
    let member_ids = match definition.property_type {
        PropertyType::Actor => value
            .as_str()
            .and_then(member_reference_id)
            .into_iter()
            .collect::<Vec<_>>(),
        PropertyType::MultiActor => value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item.as_str().and_then(member_reference_id))
            .collect::<Vec<_>>(),
        _ => return Ok(()),
    };
    for member_id in member_ids {
        let belongs = connection
            .query_row(
                "SELECT 1
                   FROM members m
                   JOIN projects p ON p.id = m.project_id
                  WHERE m.id = ?1 AND p.org_id = ?2
                    AND (?3 IS NULL OR p.slug = ?3)
                  LIMIT 1",
                params![member_id, org_id, project_slug],
                |_| Ok(true),
            )
            .optional()
            .map_err(|err| format!("typed property member ownership: {err}"))?
            .unwrap_or(false);
        if !belongs {
            return Err(format!("{PROPERTY_MEMBER_INVALID}:{member_id}"));
        }
    }
    Ok(())
}

pub(crate) fn set_value(
    request: SetWorkItemPropertyValueRequest,
) -> Result<Option<WorkItemPropertyValue>, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("typed property tx: {err}"))?;
    let definition = read_definition(&tx, &request.property_id)?;
    let now = now_ms();
    let result = set_value_in_transaction(&tx, &request, &definition, now)?;
    tx.commit()
        .map_err(|err| format!("typed property commit: {err}"))?;
    Ok(result)
}

fn set_value_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    request: &SetWorkItemPropertyValueRequest,
    definition: &PropertyDefinition,
    now: i64,
) -> Result<Option<WorkItemPropertyValue>, String> {
    let item = resolve_work_item(tx, &request.scope)?;
    if definition.org_id != item.org_id {
        return Err("Property definition belongs to another organization".to_string());
    }
    if definition.archived_at.is_some() {
        return Err("Archived properties are read-only".to_string());
    }
    if let Some(value) = request.value.as_ref() {
        validate_value(definition, value)?;
        validate_member_ownership(
            tx,
            definition,
            value,
            &item.org_id,
            item.project_slug.as_deref(),
        )?;
        let raw = serde_json::to_string(value)
            .map_err(|err| format!("typed property value serialization: {err}"))?;
        tx.execute(
            "INSERT INTO pm_work_item_property_values (
                 property_id, scope_key, work_item_id, value_json, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(property_id, scope_key, work_item_id) DO UPDATE SET
                 value_json = excluded.value_json,
                 updated_at = excluded.updated_at",
            params![request.property_id, item.scope_key, item.short_id, raw, now],
        )
        .map_err(|err| format!("typed property store: {err}"))?;
    } else {
        // Keep a null tombstone instead of deleting the row. The collaboration
        // payload must distinguish "cleared here" from "an older peer omitted
        // this property" so a clear cannot be resurrected on another device.
        tx.execute(
            "INSERT INTO pm_work_item_property_values (
                 property_id, scope_key, work_item_id, value_json, updated_at
             ) VALUES (?1, ?2, ?3, 'null', ?4)
             ON CONFLICT(property_id, scope_key, work_item_id) DO UPDATE SET
                 value_json = 'null', updated_at = excluded.updated_at",
            params![request.property_id, item.scope_key, item.short_id, now],
        )
        .map_err(|err| format!("typed property store: {err}"))?;
    }
    crate::sync::collab_bridge::record_work_item_payload_touch_in_connection(
        tx,
        &item.org_id,
        item.project_slug.as_deref(),
        &item.row_id,
        &format!("propertyValues.{}", request.property_id),
    )?;
    append_audit(
        tx,
        &item,
        if request.value.is_some() {
            "work.property_set"
        } else {
            "work.property_clear"
        },
        item.revision,
        None,
        serde_json::json!({
            "propertyId": request.property_id,
            "propertyName": definition.name,
            "value": request.value,
        }),
    )?;
    Ok(request.value.clone().map(|value| WorkItemPropertyValue {
        definition: definition.clone(),
        value,
        updated_at: iso8601(now),
    }))
}

/// Apply one property value to a set of Work Items atomically. All target
/// scopes are resolved before commit and every write, audit row, and sync
/// touch shares the same `IMMEDIATE` transaction.
pub(crate) fn batch_set_values(
    org_id: String,
    project_slug: Option<String>,
    short_ids: Vec<String>,
    property_id: String,
    value: Option<serde_json::Value>,
) -> Result<usize, String> {
    let short_ids = short_ids
        .into_iter()
        .map(|short_id| short_id.trim().to_string())
        .filter(|short_id| !short_id.is_empty())
        .collect::<BTreeSet<_>>();
    if short_ids.is_empty() {
        return Ok(0);
    }

    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("typed property batch tx: {err}"))?;
    let definition = read_definition(&tx, &property_id)?;
    if definition.org_id != org_id {
        return Err("Property definition belongs to another organization".to_string());
    }
    if definition.archived_at.is_some() {
        return Err("Archived properties are read-only".to_string());
    }
    if let Some(value) = value.as_ref() {
        validate_value(&definition, value)?;
    }

    let now = now_ms();
    for short_id in &short_ids {
        set_value_in_transaction(
            &tx,
            &SetWorkItemPropertyValueRequest {
                scope: WorkItemScope {
                    project_slug: project_slug.clone(),
                    org_id: org_id.clone(),
                    work_item_id: short_id.clone(),
                },
                property_id: property_id.clone(),
                value: value.clone(),
            },
            &definition,
            now,
        )?;
    }
    tx.commit()
        .map_err(|err| format!("typed property batch commit: {err}"))?;
    Ok(short_ids.len())
}

pub(crate) fn list_values(scope: &WorkItemScope) -> Result<Vec<WorkItemPropertyValue>, String> {
    let connection = conn()?;
    let item = resolve_work_item(&connection, scope)?;
    let mut statement = connection
        .prepare(
            "SELECT d.id, d.org_id, d.name, d.property_type, d.description,
                    d.config_json, d.position, d.archived_at, d.created_at,
                    d.updated_at, v.value_json, v.updated_at
               FROM pm_work_item_property_values v
               JOIN pm_property_definitions d ON d.id = v.property_id
              WHERE v.scope_key = ?1 AND v.work_item_id = ?2
                AND v.value_json <> 'null'
              ORDER BY d.position ASC, d.created_at ASC, d.id ASC",
        )
        .map_err(|err| format!("typed property store: {err}"))?;
    let rows = statement
        .query_map(params![item.scope_key, item.short_id], |row| {
            let definition = decode_definition(row)?;
            let raw: String = row.get(10)?;
            let updated_at: i64 = row.get(11)?;
            Ok((definition, raw, updated_at))
        })
        .map_err(|err| format!("typed property store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("typed property store: {err}"))?;
    rows.into_iter()
        .map(|(definition, raw, updated_at)| {
            Ok(WorkItemPropertyValue {
                definition,
                value: serde_json::from_str(&raw)
                    .map_err(|err| format!("typed property value decode: {err}"))?,
                updated_at: iso8601(updated_at),
            })
        })
        .collect()
}

/// Every value in a scope, for list/table columns. Lean rows — callers
/// already hold the definitions.
pub(crate) fn list_values_for_scope(
    org_id: &str,
    project_slug: Option<&str>,
) -> Result<Vec<super::ScopePropertyValue>, String> {
    let connection = conn()?;
    let scope_key = super::store::scope_key(project_slug, org_id);
    let mut statement = connection
        .prepare(
            "SELECT property_id, work_item_id, value_json
               FROM pm_work_item_property_values
              WHERE scope_key = ?1
              ORDER BY work_item_id ASC, property_id ASC",
        )
        .map_err(|err| format!("typed property store: {err}"))?;
    let values = statement
        .query_map(params![scope_key], |row| {
            let raw: String = row.get(2)?;
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, raw))
        })
        .map_err(|err| format!("typed property store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("typed property store: {err}"))?
        .into_iter()
        .map(|(property_id, work_item_id, raw)| {
            Ok(super::ScopePropertyValue {
                property_id,
                work_item_id,
                value: serde_json::from_str(&raw)
                    .map_err(|err| format!("typed property value: {err}"))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(values)
}

pub(crate) fn export_definitions(
    connection: &Connection,
    org_id: &str,
) -> Result<Vec<PropertyDefinition>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, org_id, name, property_type, description, config_json,
                    position, archived_at, created_at, updated_at
               FROM pm_property_definitions
              WHERE org_id = ?1
              ORDER BY position ASC, created_at ASC, id ASC",
        )
        .map_err(|err| format!("typed property export: {err}"))?;
    let definitions = statement
        .query_map(params![org_id], decode_definition)
        .map_err(|err| format!("typed property export: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("typed property export: {err}"))?;
    Ok(definitions)
}

pub(crate) fn export_work_item_snapshot(
    connection: &Connection,
    org_id: &str,
    work_item_row_id: &str,
    definitions: Vec<PropertyDefinition>,
) -> Result<TypedPropertyWireSnapshot, String> {
    let scope: Option<(String, String)> = connection
        .query_row(
            "SELECT CASE
                        WHEN p.slug IS NULL THEN 'org:' || w.org_id
                        ELSE 'project:' || p.slug
                    END,
                    w.short_id
               FROM workitems w
               LEFT JOIN projects p ON p.id = w.project_id
              WHERE w.id = ?1 AND w.org_id = ?2",
            params![work_item_row_id, org_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("typed property export scope: {err}"))?;
    let Some((scope_key, short_id)) = scope else {
        return Ok(TypedPropertyWireSnapshot {
            definitions,
            values: Vec::new(),
        });
    };
    let mut statement = connection
        .prepare(
            "SELECT property_id, value_json, updated_at
               FROM pm_work_item_property_values
              WHERE scope_key = ?1 AND work_item_id = ?2
              ORDER BY property_id ASC",
        )
        .map_err(|err| format!("typed property export: {err}"))?;
    let values = statement
        .query_map(params![scope_key, short_id], |row| {
            let raw: String = row.get(1)?;
            Ok((row.get::<_, String>(0)?, raw, row.get::<_, i64>(2)?))
        })
        .map_err(|err| format!("typed property export: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("typed property export: {err}"))?
        .into_iter()
        .map(|(property_id, raw, updated_at)| {
            Ok(SyncedWorkItemPropertyValue {
                property_id,
                value: serde_json::from_str(&raw)
                    .map_err(|err| format!("typed property export value: {err}"))?,
                updated_at: iso8601(updated_at),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(TypedPropertyWireSnapshot {
        definitions,
        values,
    })
}

fn timestamp_ms(value: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .map_err(|err| format!("typed property wire timestamp '{value}': {err}"))
}

pub(crate) fn validate_wire_definitions(
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let Some(raw) = payload.get("propertyDefinitions") else {
        return Ok(());
    };
    let definitions: Vec<PropertyDefinition> = serde_json::from_value(raw.clone())
        .map_err(|err| format!("typed property wire definitions: {err}"))?;
    for definition in definitions.iter().filter(|item| item.org_id == org_id) {
        validate_definition_fields(
            &definition.name,
            definition.property_type,
            &definition.config,
        )?;
        timestamp_ms(&definition.created_at)?;
        timestamp_ms(&definition.updated_at)?;
        definition
            .archived_at
            .as_deref()
            .map(timestamp_ms)
            .transpose()?;
    }
    Ok(())
}

pub(crate) fn apply_wire_definitions(
    connection: &Connection,
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    validate_wire_definitions(org_id, payload)?;
    let Some(raw) = payload.get("propertyDefinitions") else {
        return Ok(());
    };
    let definitions: Vec<PropertyDefinition> = serde_json::from_value(raw.clone())
        .map_err(|err| format!("typed property wire definitions: {err}"))?;
    for definition in definitions {
        if definition.org_id != org_id {
            continue;
        }
        let name = validate_definition_fields(
            &definition.name,
            definition.property_type,
            &definition.config,
        )?;
        let local: Option<(String, String, i64)> = connection
            .query_row(
                "SELECT org_id, property_type, updated_at
                   FROM pm_property_definitions WHERE id = ?1",
                params![definition.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|err| format!("typed property definition watermark: {err}"))?;
        if local
            .as_ref()
            .is_some_and(|(stored_org, _, _)| stored_org != org_id)
        {
            continue;
        }
        let remote_updated_at = timestamp_ms(&definition.updated_at)?;
        let local_updated_at = local.as_ref().map(|(_, _, updated_at)| *updated_at);
        if local_updated_at.is_some_and(|local| local >= remote_updated_at) {
            continue;
        }
        if crate::sync::collab_bridge::has_pending_collab_field_path(
            connection,
            org_id,
            &format!("propertyDefinitions.{}", definition.id),
            "typed property pending-path probe",
        )? {
            continue;
        }
        if let Some((_, stored_type, _)) = &local {
            validate_definition_type_change(
                connection,
                &definition.id,
                stored_type,
                definition.property_type,
            )?;
        }
        let config_json = serde_json::to_string(&definition.config)
            .map_err(|err| format!("typed property wire config: {err}"))?;
        connection
            .execute(
                "INSERT INTO pm_property_definitions (
                     id, org_id, name, property_type, description, config_json,
                     position, archived_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     property_type = excluded.property_type,
                     description = excluded.description,
                     config_json = excluded.config_json,
                     position = excluded.position,
                     archived_at = excluded.archived_at,
                     updated_at = excluded.updated_at
                 WHERE pm_property_definitions.org_id = excluded.org_id
                   AND excluded.updated_at >= pm_property_definitions.updated_at",
                params![
                    definition.id,
                    definition.org_id,
                    name,
                    definition.property_type.as_str(),
                    definition.description,
                    config_json,
                    definition.position,
                    definition
                        .archived_at
                        .as_deref()
                        .map(timestamp_ms)
                        .transpose()?,
                    timestamp_ms(&definition.created_at)?,
                    remote_updated_at,
                ],
            )
            .map_err(|err| format!("typed property apply definition: {err}"))?;
    }
    Ok(())
}

pub(crate) fn apply_work_item_wire_snapshot(
    connection: &Connection,
    org_id: &str,
    work_item_row_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    apply_wire_definitions(connection, org_id, payload)?;
    let Some(raw) = payload.get("propertyValues") else {
        return Ok(());
    };
    let values: Vec<SyncedWorkItemPropertyValue> = serde_json::from_value(raw.clone())
        .map_err(|err| format!("typed property wire values: {err}"))?;
    let scope: Option<(String, String, Option<String>)> = connection
        .query_row(
            "SELECT CASE
                        WHEN p.slug IS NULL THEN 'org:' || w.org_id
                        ELSE 'project:' || p.slug
                    END,
                    w.short_id,
                    p.slug
               FROM workitems w
               LEFT JOIN projects p ON p.id = w.project_id
              WHERE w.id = ?1 AND w.org_id = ?2",
            params![work_item_row_id, org_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| format!("typed property apply scope: {err}"))?;
    let Some((scope_key, short_id, project_slug)) = scope else {
        return Err(format!(
            "typed property apply Work Item '{work_item_row_id}' not found"
        ));
    };
    for value in values {
        let definition = match find_definition(connection, &value.property_id)? {
            Some(definition) if definition.org_id == org_id => definition,
            Some(_) | None => continue,
        };
        if !value.value.is_null() {
            validate_value(&definition, &value.value)?;
            validate_member_ownership(
                connection,
                &definition,
                &value.value,
                org_id,
                project_slug.as_deref(),
            )?;
        }
        let remote_updated_at = timestamp_ms(&value.updated_at)?;
        let local_updated_at: Option<i64> = connection
            .query_row(
                "SELECT updated_at FROM pm_work_item_property_values
                  WHERE property_id = ?1 AND scope_key = ?2 AND work_item_id = ?3",
                params![value.property_id, scope_key, short_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("typed property value watermark: {err}"))?;
        if local_updated_at.is_some_and(|local| local >= remote_updated_at) {
            continue;
        }
        if crate::sync::collab_bridge::has_pending_collab_field_path(
            connection,
            org_id,
            &format!("propertyValues.{}", value.property_id),
            "typed property pending-path probe",
        )? {
            continue;
        }
        let raw = serde_json::to_string(&value.value)
            .map_err(|err| format!("typed property wire value: {err}"))?;
        connection
            .execute(
                "INSERT INTO pm_work_item_property_values (
                     property_id, scope_key, work_item_id, value_json, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(property_id, scope_key, work_item_id) DO UPDATE SET
                     value_json = excluded.value_json,
                     updated_at = excluded.updated_at
                 WHERE excluded.updated_at >= pm_work_item_property_values.updated_at",
                params![
                    value.property_id,
                    scope_key,
                    short_id,
                    raw,
                    remote_updated_at,
                ],
            )
            .map_err(|err| format!("typed property apply value: {err}"))?;
    }
    Ok(())
}
