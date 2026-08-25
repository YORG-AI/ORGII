//! Geometry-aware inline WebView occlusion.
//!
//! Native child WebViews do not participate in the React DOM stacking
//! context. On macOS we keep the live WKWebView in front, but apply a
//! `CAShapeLayer` mask with holes matching opaque React overlays. Translucent
//! modal scrims are mirrored by a named black `CALayer` above the live page.
//! This keeps the rest of the page painted instead of moving the entire
//! WebView behind the opaque main app surface.

use serde::Deserialize;
use tauri::{AppHandle, Manager};

const MAX_OCCLUSION_RECTS: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebviewOcclusionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn sanitize_occlusion_rects(
    rects: &[WebviewOcclusionRect],
    surface_width: f64,
    surface_height: f64,
) -> Vec<WebviewOcclusionRect> {
    if !surface_width.is_finite()
        || !surface_height.is_finite()
        || surface_width <= 0.0
        || surface_height <= 0.0
    {
        return Vec::new();
    }

    rects
        .iter()
        .take(MAX_OCCLUSION_RECTS)
        .filter_map(|rect| {
            if !rect.x.is_finite()
                || !rect.y.is_finite()
                || !rect.width.is_finite()
                || !rect.height.is_finite()
                || rect.width <= 0.0
                || rect.height <= 0.0
            {
                return None;
            }

            let left = rect.x.max(0.0).min(surface_width);
            let top = rect.y.max(0.0).min(surface_height);
            let right = (rect.x + rect.width).max(0.0).min(surface_width);
            let bottom = (rect.y + rect.height).max(0.0).min(surface_height);
            if right <= left || bottom <= top {
                return None;
            }

            Some(WebviewOcclusionRect {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
            })
        })
        .collect()
}

fn sanitize_dimming_alpha(dimming_alpha: f64) -> f32 {
    if !dimming_alpha.is_finite() {
        return 0.0;
    }
    dimming_alpha.clamp(0.0, 1.0) as f32
}

/// Apply overlay holes to one inline WebView.
///
/// `rects` are WebView-local logical points with a top-left origin. The
/// frontend derives them from the same scaled frame used to position the
/// native child view. `dimming_alpha` mirrors a translucent black DOM scrim
/// without turning the full WebView into an opaque compositor hole.
#[tauri::command]
pub async fn set_inline_webview_occlusions(
    app: AppHandle,
    label: String,
    rects: Vec<WebviewOcclusionRect>,
    block_input: bool,
    dimming_alpha: f64,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        // Creation and teardown race with overlay effects; a missing surface
        // is already in the desired non-interactive/non-painted state.
        return Ok(());
    };

    #[cfg(target_os = "macos")]
    {
        let main_webview = app.get_webview("main");
        apply_macos_occlusions(&webview, main_webview, rects, block_input, dimming_alpha).await
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        let _ = rects;
        let _ = block_input;
        let _ = dimming_alpha;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{sanitize_dimming_alpha, sanitize_occlusion_rects, WebviewOcclusionRect};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel, Message};
    use objc2_app_kit::NSColor;
    use objc2_core_graphics::CGMutablePath;
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use objc2_quartz_core::{kCAFillRuleEvenOdd, CALayer, CAShapeLayer, CATransaction};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    type HitTestImplementation =
        unsafe extern "C-unwind" fn(&AnyObject, Sel, NSPoint) -> *mut AnyObject;

    /// Maps an occluded inline WKWebView to the main React WKWebView that must
    /// receive pointer input while an interactive overlay is open.
    static INPUT_TARGET_WEBVIEWS: OnceLock<Mutex<HashMap<usize, usize>>> = OnceLock::new();
    static ORIGINAL_HIT_TESTS: OnceLock<Mutex<HashMap<usize, Imp>>> = OnceLock::new();
    const DIMMING_LAYER_NAME: &str = "org2.inline-webview-dimming";

    fn input_target_webviews() -> &'static Mutex<HashMap<usize, usize>> {
        INPUT_TARGET_WEBVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn original_hit_tests() -> &'static Mutex<HashMap<usize, Imp>> {
        ORIGINAL_HIT_TESTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn input_target_webview(webview: &AnyObject) -> Option<usize> {
        input_target_webviews().lock().ok().and_then(|targets| {
            targets
                .get(&(webview as *const AnyObject as usize))
                .copied()
        })
    }

    fn original_hit_test(this: &AnyObject, command: Sel, point: NSPoint) -> *mut AnyObject {
        let original = original_hit_tests().lock().ok().and_then(|originals| {
            let mut class = Some(this.class());
            while let Some(candidate) = class {
                let key = candidate as *const AnyClass as usize;
                if let Some(implementation) = originals.get(&key) {
                    return Some(*implementation);
                }
                class = candidate.superclass();
            }
            None
        });
        let Some(original) = original else {
            return std::ptr::null_mut();
        };

        let original: HitTestImplementation = unsafe { std::mem::transmute(original) };
        unsafe { original(this, command, point) }
    }

    extern "C-unwind" fn hit_test(this: &AnyObject, _cmd: Sel, point: NSPoint) -> *mut AnyObject {
        let key = this as *const AnyObject as usize;
        if let Some(target_key) = input_target_webview(this) {
            // Route directly to the main React WKWebView. Asking the inline
            // WebView's parent to re-run hit testing can return nil when the
            // two WebViews have different native container views; AppKit may
            // then deliver the click to a window in another application.
            if target_key != 0 && target_key != key {
                let target = unsafe { &*(target_key as *const AnyObject) };
                let point_in_target: NSPoint =
                    unsafe { msg_send![this, convertPoint: point, toView: target] };
                let routed: *mut AnyObject = unsafe { msg_send![target, hitTest: point_in_target] };
                if !routed.is_null() {
                    return routed;
                }
            }

            // Fail closed: keeping the event inside ORG2 is safer than a bare
            // nil, even if the main surface is temporarily being recreated.
            return original_hit_test(this, _cmd, point);
        }

        original_hit_test(this, _cmd, point)
    }

    fn ensure_hit_test_hook(webview: &AnyObject) -> Result<(), String> {
        let class = webview.class();
        let class_key = class as *const AnyClass as usize;
        let mut originals = original_hit_tests()
            .lock()
            .map_err(|_| "native WebView hit-test registry is poisoned".to_string())?;
        if originals.contains_key(&class_key) {
            return Ok(());
        }

        let selector = sel!(hitTest:);
        let method = class
            .instance_method(selector)
            .ok_or_else(|| "WKWebView has no hitTest: method".to_string())?;
        let inherited_implementation = method.implementation();
        let replacement: Imp =
            unsafe { std::mem::transmute::<HitTestImplementation, Imp>(hit_test) };
        let type_encoding = unsafe { objc2::ffi::method_getTypeEncoding(method) };
        if type_encoding.is_null() {
            return Err("WKWebView hitTest: has no type encoding".to_string());
        }

        // Add/replace on the WebView's existing class. Avoid object_setClass:
        // AppKit may KVO-observe NSView.frame, and changing an individual
        // WKWebView's runtime class can invalidate that observation chain.
        let previous = unsafe {
            objc2::ffi::class_replaceMethod(
                class as *const AnyClass as *mut AnyClass,
                selector,
                replacement,
                type_encoding,
            )
        };
        originals.insert(class_key, previous.unwrap_or(inherited_implementation));
        Ok(())
    }

    fn set_input_target(webview: &AnyObject, target: Option<usize>) -> Result<(), String> {
        let key = webview as *const AnyObject as usize;
        if target.is_some() {
            ensure_hit_test_hook(webview)?;
        }

        let mut registry = input_target_webviews()
            .lock()
            .map_err(|_| "native WebView input registry is poisoned".to_string())?;
        if let Some(target) = target {
            registry.insert(key, target);
        } else {
            registry.remove(&key);
        }
        Ok(())
    }

    async fn native_webview_pointer(webview: &tauri::Webview) -> Result<usize, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |wv| {
                let pointer = wv.inner() as *mut AnyObject as usize;
                let _ = sender.send(pointer);
            })
            .map_err(|error| format!("with_webview failed: {error}"))?;

        let pointer = receiver
            .await
            .map_err(|_| "native WebView pointer task was cancelled".to_string())?;
        if pointer == 0 {
            return Err("WKWebView pointer is null".to_string());
        }
        Ok(pointer)
    }

    fn find_dimming_layer(root_layer: &CALayer) -> Option<objc2::rc::Retained<CALayer>> {
        unsafe { root_layer.sublayers() }.and_then(|sublayers| {
            sublayers
                .iter()
                .find(|candidate| {
                    candidate
                        .name()
                        .is_some_and(|name| name.to_string() == DIMMING_LAYER_NAME)
                })
                .map(|candidate| candidate.retain())
        })
    }

    fn update_dimming_layer(root_layer: &CALayer, bounds: NSRect, dimming_alpha: f64) {
        let dimming_alpha = sanitize_dimming_alpha(dimming_alpha);
        let existing = find_dimming_layer(root_layer);

        if dimming_alpha <= 0.0 {
            if let Some(layer) = existing {
                layer.removeFromSuperlayer();
            }
            return;
        }

        let dimming_layer = existing.unwrap_or_else(|| {
            let layer = CALayer::layer();
            let name = NSString::from_str(DIMMING_LAYER_NAME);
            layer.setName(Some(&name));
            root_layer.addSublayer(&layer);
            layer
        });
        let black = NSColor::blackColor().CGColor();
        dimming_layer.setFrame(bounds);
        dimming_layer.setBackgroundColor(Some(&black));
        dimming_layer.setOpacity(dimming_alpha);
        dimming_layer.setZPosition(1_000_000.0);
    }

    pub(super) async fn apply(
        webview: &tauri::Webview,
        main_webview: Option<tauri::Webview>,
        rects: Vec<WebviewOcclusionRect>,
        block_input: bool,
        dimming_alpha: f64,
    ) -> Result<(), String> {
        let input_target = if block_input {
            let main_webview = main_webview
                .as_ref()
                .ok_or_else(|| "main React WebView is unavailable".to_string())?;
            Some(native_webview_pointer(main_webview).await?)
        } else {
            None
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();

        webview
            .with_webview(move |wv| {
                let result = (|| -> Result<(), String> {
                    let wk_webview: *mut AnyObject = wv.inner() as *mut AnyObject;
                    if wk_webview.is_null() {
                        return Err("WKWebView pointer is null".to_string());
                    }
                    let wk_webview = unsafe { &*wk_webview };

                    set_input_target(wk_webview, input_target)?;

                    unsafe {
                        let _: () = msg_send![wk_webview, setWantsLayer: true];
                        let layer: *mut CALayer = msg_send![wk_webview, layer];
                        if layer.is_null() {
                            return Err("WKWebView has no backing layer".to_string());
                        }
                        let layer = &*layer;

                        let bounds: NSRect = msg_send![wk_webview, bounds];
                        let sanitized =
                            sanitize_occlusion_rects(&rects, bounds.size.width, bounds.size.height);

                        CATransaction::begin();
                        CATransaction::setDisableActions(true);

                        if sanitized.is_empty() {
                            layer.setMask(None);
                        } else {
                            let is_flipped: bool = msg_send![wk_webview, isFlipped];
                            let path = CGMutablePath::new();
                            CGMutablePath::add_rect(Some(&path), std::ptr::null(), bounds);

                            for rect in sanitized {
                                let y = if is_flipped {
                                    bounds.origin.y + rect.y
                                } else {
                                    bounds.origin.y + bounds.size.height - rect.y - rect.height
                                };
                                let hole = NSRect::new(
                                    NSPoint::new(bounds.origin.x + rect.x, y),
                                    NSSize::new(rect.width, rect.height),
                                );
                                CGMutablePath::add_rect(Some(&path), std::ptr::null(), hole);
                            }

                            let mask = CAShapeLayer::layer();
                            mask.setFrame(bounds);
                            mask.setPath(Some(&path));
                            mask.setFillRule(kCAFillRuleEvenOdd);
                            layer.setMask(Some(&mask));
                        }

                        update_dimming_layer(layer, bounds, dimming_alpha);
                        CATransaction::commit();
                    }

                    Ok(())
                })();
                let _ = sender.send(result);
            })
            .map_err(|error| format!("with_webview failed: {error}"))?;

        receiver
            .await
            .map_err(|_| "occlusion main-thread task was cancelled".to_string())?
    }

    pub(super) fn clear(webview: &tauri::Webview) {
        let _ = webview.with_webview(|wv| unsafe {
            let wk_webview: *mut AnyObject = wv.inner() as *mut AnyObject;
            if wk_webview.is_null() {
                return;
            }
            let wk_webview = &*wk_webview;
            let _ = set_input_target(wk_webview, None);
            let layer: *mut CALayer = msg_send![wk_webview, layer];
            if !layer.is_null() {
                CATransaction::begin();
                CATransaction::setDisableActions(true);
                let layer = &*layer;
                layer.setMask(None);
                update_dimming_layer(layer, NSRect::ZERO, 0.0);
                CATransaction::commit();
            }
        });
    }
}

#[cfg(target_os = "macos")]
async fn apply_macos_occlusions(
    webview: &tauri::Webview,
    main_webview: Option<tauri::Webview>,
    rects: Vec<WebviewOcclusionRect>,
    block_input: bool,
    dimming_alpha: f64,
) -> Result<(), String> {
    macos::apply(webview, main_webview, rects, block_input, dimming_alpha).await
}

/// Clear native projection state before closing a WebView so pointer-address
/// reuse cannot inherit a stale input block.
pub(crate) fn clear_webview_occlusions(webview: &tauri::Webview) {
    #[cfg(target_os = "macos")]
    macos::clear(webview);

    #[cfg(not(target_os = "macos"))]
    let _ = webview;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_and_clips_rectangles_to_surface_bounds() {
        let rects = sanitize_occlusion_rects(
            &[
                WebviewOcclusionRect {
                    x: -5.0,
                    y: 10.0,
                    width: 20.0,
                    height: 30.0,
                },
                WebviewOcclusionRect {
                    x: 95.0,
                    y: 70.0,
                    width: 20.0,
                    height: 20.0,
                },
                WebviewOcclusionRect {
                    x: f64::NAN,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
            ],
            100.0,
            80.0,
        );

        assert_eq!(
            rects,
            vec![
                WebviewOcclusionRect {
                    x: 0.0,
                    y: 10.0,
                    width: 15.0,
                    height: 30.0,
                },
                WebviewOcclusionRect {
                    x: 95.0,
                    y: 70.0,
                    width: 5.0,
                    height: 10.0,
                },
            ]
        );
    }

    #[test]
    fn bounds_native_path_complexity() {
        let rects = vec![
            WebviewOcclusionRect {
                x: 1.0,
                y: 1.0,
                width: 1.0,
                height: 1.0,
            };
            MAX_OCCLUSION_RECTS + 10
        ];

        assert_eq!(
            sanitize_occlusion_rects(&rects, 100.0, 100.0).len(),
            MAX_OCCLUSION_RECTS
        );
    }

    #[test]
    fn sanitizes_native_dimming_alpha() {
        assert_eq!(sanitize_dimming_alpha(f64::NAN), 0.0);
        assert_eq!(sanitize_dimming_alpha(-0.5), 0.0);
        assert_eq!(sanitize_dimming_alpha(0.6), 0.6);
        assert_eq!(sanitize_dimming_alpha(4.0), 1.0);
    }
}
