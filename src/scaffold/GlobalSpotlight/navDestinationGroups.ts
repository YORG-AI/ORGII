/**
 * Navigation destination group data arrays (INTEGRATIONS, MARKET, ACTIONS).
 * Extracted from navDestinations.ts to keep that file under the config line limit.
 * PAGES and SETTINGS stay in navDestinations.ts since they are smaller.
 */
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

import {
  WIZARD_IDS,
  type WizardId,
  buildAgentOrgsPath,
  buildExternalSkillsetsPath,
  buildIntegrationsPath,
  buildWizardPath,
  getPathIcon,
  getSegmentIcon,
} from "@src/config/mainAppPaths";
import { ROUTES } from "@src/config/routes";

import type {
  NavDestination,
  NavDestinationGroup,
} from "./navDestinationsTypes";

// ============================================================================
// Local helper copies (mirror the private helpers in navDestinations.ts)
// ============================================================================

function resolveIcon(path: string, overrideIcon?: LucideIcon): LucideIcon {
  if (overrideIcon) return overrideIcon;
  const icon = getPathIcon(path);
  if (!icon) {
    throw new Error(
      `NavDestinations: no SEGMENT_REGISTRY icon for path "${path}" ` +
        `— add an entry in SEGMENT_REGISTRY or pass an override.`
    );
  }
  return icon;
}

function dest(
  id: string,
  path: string,
  group: NavDestinationGroup,
  opts: {
    overrideIcon?: LucideIcon;
    keywords?: string[];
    labelKey?: string;
    descriptionSuffixKey?: string;
    searchable?: boolean;
  } = {}
): NavDestination {
  return {
    id,
    path,
    icon: resolveIcon(path, opts.overrideIcon) as unknown as ComponentType<
      Record<string, unknown>
    >,
    keywords: opts.keywords,
    group,
    labelKey: opts.labelKey,
    descriptionSuffixKey: opts.descriptionSuffixKey,
    searchable: opts.searchable,
  };
}

function wizardDest(
  id: string,
  basePath: string,
  wizardId: WizardId,
  opts: {
    labelKey: string;
    overrideIcon?: LucideIcon;
    keywords?: string[];
  }
): NavDestination {
  return dest(id, buildWizardPath(basePath, wizardId), "actions", {
    overrideIcon: opts.overrideIcon,
    keywords: opts.keywords,
    labelKey: opts.labelKey,
  });
}

// ============================================================================
// INTEGRATIONS (deep-linked into AgentOrgs)
// ============================================================================

export const INTEGRATIONS: NavDestination[] = [
  dest(
    "nav-int-models",
    buildIntegrationsPath({ category: "models" }),
    "integrations",
    { keywords: ["keys", "api keys", "providers", "models", "key vault"] }
  ),
  dest(
    "nav-int-tools",
    buildIntegrationsPath({ category: "tools" }),
    "integrations",
    { keywords: ["tools", "capabilities"] }
  ),
  dest(
    "nav-int-skills-mcps-plugins",
    buildExternalSkillsetsPath(),
    "integrations",
    {
      labelKey: "integrations:categories.externalSkillsets",
      searchable: false,
      keywords: [
        "mcp",
        "skills",
        "mcp skills plugins",
        "model context protocol",
        "plugins",
        "extensions",
      ],
    }
  ),
  dest(
    "nav-int-mcp",
    buildExternalSkillsetsPath({ tab: "mcp" }),
    "integrations",
    {
      labelKey: "integrations:externalSkillsets.tabs.mcp",
      descriptionSuffixKey: "integrations:externalSkillsets.tabs.mcp",
      overrideIcon: getSegmentIcon("mcp") ?? undefined,
      keywords: [
        "mcp",
        "model context protocol",
        "mcp servers",
        "mcp hub",
        "smithery",
        "glama",
      ],
    }
  ),
  dest(
    "nav-int-skills",
    buildExternalSkillsetsPath({ tab: "skills" }),
    "integrations",
    {
      labelKey: "integrations:externalSkillsets.tabs.skills",
      descriptionSuffixKey: "integrations:externalSkillsets.tabs.skills",
      overrideIcon: getSegmentIcon("skills") ?? undefined,
      keywords: ["skills", "capabilities"],
    }
  ),
  dest(
    "nav-int-connections",
    buildIntegrationsPath({ category: "connections" }),
    "integrations",
    {
      keywords: [
        "github",
        "slack",
        "discord",
        "telegram",
        "channels",
        "git providers",
      ],
    }
  ),
  dest(
    "nav-int-databases",
    buildIntegrationsPath({ category: "databases" }),
    "integrations",
    { keywords: ["databases", "db clients", "connections"] }
  ),
  dest(
    "nav-int-rules",
    buildIntegrationsPath({ category: "rulesMemoryEvolution" }),
    "integrations",
    {
      keywords: [
        "policies",
        "automation",
        "rules",
        "memory",
        "workspace memory",
        "learnings",
        "knowledge",
      ],
    }
  ),
  dest(
    "nav-int-routines",
    buildIntegrationsPath({ category: "routines" }),
    "integrations",
    { keywords: ["routines", "scheduled", "cron"] }
  ),
  dest(
    "nav-int-devtools",
    buildIntegrationsPath({ category: "devtools" }),
    "integrations",
    {
      keywords: [
        "lsp",
        "lint",
        "dependencies",
        "language servers",
        "dev tools",
      ],
    }
  ),
  dest(
    "nav-agents-tab",
    buildAgentOrgsPath({ tab: "agents" }),
    "integrations",
    {
      keywords: ["agents", "team", "members", "cli agents", "custom agents"],
    }
  ),
];

// ============================================================================
// MARKET
// ============================================================================

export const MARKET: NavDestination[] = [
  dest("nav-market-tokens", ROUTES.app.market.tokenMarket.path, "market", {
    keywords: ["tokens", "marketplace", "llm", "buy tokens", "sell tokens"],
  }),
  dest("nav-market-agent-apps", ROUTES.app.market.agentApps.path, "market", {
    keywords: ["agent market", "agent apps", "agents marketplace"],
  }),
  dest("nav-market-services", ROUTES.app.market.serviceMarket.path, "market", {
    keywords: ["services", "tasks", "marketplace"],
  }),
  dest("nav-market-wallet", ROUTES.app.market.wallet.path, "market", {
    keywords: ["wallet", "balance", "transactions", "credits"],
  }),
  dest(
    "nav-market-agent-studio",
    ROUTES.app.market.agentStudio.path,
    "market",
    {
      keywords: ["publish", "agent studio", "studio"],
    }
  ),
  dest("nav-market-earnings", ROUTES.app.market.earnings.path, "market", {
    keywords: ["earnings", "payouts", "provider"],
  }),
];

// ============================================================================
// ACTIONS (wizard entry points)
// ============================================================================

/**
 * Wizard actions deep-link into a host page and auto-open the wizard
 * via the `?wizard=<id>` query param. All wizards are URL-driven
 * (see `WIZARD_IDS` in `mainAppPaths.ts`), so the spotlight only
 * needs to `navigate(dest.path)` — no side-channel / event bus.
 */
export const ACTIONS: NavDestination[] = [
  wizardDest(
    "action-add-key",
    buildIntegrationsPath({ category: "models" }),
    WIZARD_IDS.KEY_ADD,
    {
      labelKey: "integrations:addOptions.addModel",
      keywords: ["add", "api key", "key", "provider", "model", "credential"],
    }
  ),
  wizardDest(
    "action-add-mcp",
    buildExternalSkillsetsPath({ tab: "mcp" }),
    WIZARD_IDS.MCP_ADD,
    {
      labelKey: "integrations:addOptions.addMcp",
      overrideIcon: getSegmentIcon("mcp") ?? undefined,
      keywords: [
        "mcp",
        "add mcp",
        "mcp server",
        "model context protocol",
        "install",
      ],
    }
  ),
  wizardDest(
    "action-create-skill",
    buildExternalSkillsetsPath({ tab: "skills" }),
    WIZARD_IDS.SKILL_CREATE,
    {
      labelKey: "integrations:addOptions.createSkill",
      overrideIcon: getSegmentIcon("skills") ?? undefined,
      keywords: ["skill", "create skill", "agent skill", "new skill"],
    }
  ),
  wizardDest(
    "action-add-connection",
    buildIntegrationsPath({ category: "connections" }),
    WIZARD_IDS.CHANNEL_ADD,
    {
      labelKey: "integrations:addOptions.addChannelOrService",
      keywords: [
        "connection",
        "channel",
        "slack",
        "discord",
        "github",
        "telegram",
      ],
    }
  ),
  wizardDest(
    "action-add-database",
    buildIntegrationsPath({ category: "databases" }),
    WIZARD_IDS.DB_CONNECTION_ADD,
    {
      labelKey: "integrations:addOptions.addDatabase",
      keywords: ["database", "db", "connection", "sql", "add database"],
    }
  ),
  wizardDest(
    "action-add-routine",
    buildIntegrationsPath({ category: "routines" }),
    WIZARD_IDS.ROUTINE_ADD,
    {
      labelKey: "integrations:addOptions.addRoutine",
      keywords: ["routine", "scheduled", "cron", "automation", "new routine"],
    }
  ),
  dest(
    "action-add-rule",
    buildWizardPath(
      buildIntegrationsPath({ category: "rulesMemoryEvolution" }),
      WIZARD_IDS.RULE_ADD,
      "create"
    ),
    "actions",
    {
      labelKey: "integrations:addOptions.addRule",
      keywords: ["policy", "rules", "markdown", "new policy"],
    }
  ),
  wizardDest(
    "action-add-agent",
    buildAgentOrgsPath({ tab: "agents" }),
    WIZARD_IDS.AGENT_ADD,
    {
      labelKey: "integrations:agentOrgs.addAgent",
      keywords: ["agent", "new agent", "create agent", "custom agent"],
    }
  ),
  wizardDest(
    "action-add-org",
    buildAgentOrgsPath({ tab: "agents" }),
    WIZARD_IDS.ORG_ADD,
    {
      labelKey: "integrations:agentOrgs.addOrg",
      overrideIcon: getSegmentIcon("org") ?? undefined,
      keywords: ["team", "team member", "hierarchy", "add team"],
    }
  ),
  wizardDest(
    "action-add-listing",
    ROUTES.app.market.tokenMarket.path,
    WIZARD_IDS.LISTING_ADD,
    {
      labelKey: "market:market.listing.addListing",
      keywords: [
        "listing",
        "publish",
        "sell tokens",
        "provider listing",
        "marketplace listing",
      ],
    }
  ),
];
