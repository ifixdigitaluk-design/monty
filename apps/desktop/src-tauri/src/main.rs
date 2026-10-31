// Monty desktop shell (ADR-010 proof of compatibility).
//
// Loads the Monty web app from MONTY_URL (default http://localhost:3000) in a native window, so web and desktop
// share one UI, one API and one permission model. The remote page is granted no Tauri/native APIs (see
// capabilities/default.json); navigation is restricted to the configured origin and external links open in the
// system browser. Offline cache, keychain token storage, native notifications and signed auto-update are later steps.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{webview::PageLoadEvent, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// Address baked in at build time (release builds set MONTY_DEFAULT_URL to the team's https address);
/// the MONTY_URL environment variable can still override it on a given machine.
const DEFAULT_URL: &str = match option_env!("MONTY_DEFAULT_URL") {
    Some(u) => u,
    None => "http://localhost:3000",
};

fn app_url() -> Url {
    let raw = std::env::var("MONTY_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());
    match Url::parse(&raw) {
        Ok(u) if u.scheme() == "https" || (u.scheme() == "http" && matches!(u.host_str(), Some("localhost") | Some("127.0.0.1"))) => u,
        _ => {
            eprintln!("MONTY_URL must be https:// (or http://localhost for development); using http://localhost:3000");
            Url::parse("http://localhost:3000").expect("static url")
        }
    }
}

/// Only the configured Monty origin may load inside the app window.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

fn main() {
    let home = app_url();
    tauri::Builder::default()
        .setup(move |app| {
            let allowed = home.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(home.clone()))
                .title("Monty")
                .inner_size(1280.0, 832.0)
                .min_inner_size(380.0, 600.0)
                .on_navigation(move |url| same_origin(url, &allowed))
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        let _ = window.set_title("Monty");
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Monty");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_is_limited_to_the_app_origin() {
        let home = Url::parse("https://app.monty.example").unwrap();
        assert!(same_origin(&Url::parse("https://app.monty.example/project?id=1").unwrap(), &home));
        assert!(!same_origin(&Url::parse("https://evil.example/").unwrap(), &home));
        assert!(!same_origin(&Url::parse("http://app.monty.example/").unwrap(), &home));
        assert!(!same_origin(&Url::parse("https://app.monty.example:8443/").unwrap(), &home));
    }
}
