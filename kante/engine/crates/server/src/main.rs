//! `kante` — data build pipeline and HTTP server.
//!
//! ```text
//! kante build [--data DIR] [--walk-bbox S,W,N,E] [--only a,b] [--force] [--without-register]
//! kante serve [--data DIR] [--port 8080] [--bind 0.0.0.0] [--app DIR]
//! ```

mod api;
mod build;
mod json;
mod formation;
mod live;
mod identify;
mod liveapi;
mod profiles;
mod plan;
mod state;

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::sync::Arc;

pub struct Args {
    flags: Vec<(String, Option<String>)>,
}

impl Args {
    fn parse(raw: &[String]) -> Result<Args> {
        let mut flags = Vec::new();
        let mut i = 0;
        while i < raw.len() {
            let a = &raw[i];
            let Some(name) = a.strip_prefix("--") else { bail!("unexpected argument {a:?}") };
            if let Some((k, v)) = name.split_once('=') {
                flags.push((k.to_string(), Some(v.to_string())));
            } else if i + 1 < raw.len() && !raw[i + 1].starts_with("--") {
                flags.push((name.to_string(), Some(raw[i + 1].clone())));
                i += 1;
            } else {
                flags.push((name.to_string(), None));
            }
            i += 1;
        }
        Ok(Args { flags })
    }
    pub fn get(&self, name: &str) -> Option<&str> {
        self.flags.iter().find(|f| f.0 == name).and_then(|f| f.1.as_deref())
    }
    pub fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f.0 == name)
    }
    pub fn data_dir(&self) -> PathBuf {
        self.get("data").map(PathBuf::from).or_else(|| std::env::var_os("KANTE_DATA").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("data"))
    }
}

fn main() -> Result<()> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, rest) = match raw.split_first() {
        Some((c, r)) => (c.as_str(), r),
        None => ("help", &[][..]),
    };
    let args = Args::parse(rest)?;
    match cmd {
        "build" => build::run(&args),
        "serve" => serve(&args),
        _ => {
            eprintln!("usage:\n  kante build [--data DIR] [--walk-bbox S,W,N,E] [--only timetable,osm,doors,elevation,links,search] [--force] [--without-register]\n  kante serve [--data DIR] [--port 8080] [--bind 0.0.0.0] [--app DIR]");
            Ok(())
        }
    }
}

fn serve(args: &Args) -> Result<()> {
    let data = args.data_dir();
    let app = Arc::new(state::App::load(&data)?);
    live::start(app.clone());
    profiles::start(app.clone());

    let port: u16 = args.get("port").map(|p| p.parse()).transpose().context("--port")?.unwrap_or(8080);
    let bind = args.get("bind").unwrap_or("0.0.0.0").to_string();
    let app_dir = PathBuf::from(args.get("app").unwrap_or("app/dist"));

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(async move {
        use tower_http::compression::CompressionLayer;
        use tower_http::services::{ServeDir, ServeFile};
        let stopping = app.shutdown.clone();
        let mut router = api::routes(app);
        if app_dir.join("index.html").exists() {
            // Single-page app: unknown paths fall back to index.html.
            let files = ServeDir::new(&app_dir).fallback(ServeFile::new(app_dir.join("index.html")));
            router = router.fallback_service(files);
        } else {
            eprintln!("note: {} has no index.html; serving the API only (build the app with `npm run build` in app/)", app_dir.display());
        }
        let router = router.layer(CompressionLayer::new()).layer(tower_http::cors::CorsLayer::permissive());
        let listener = tokio::net::TcpListener::bind((bind.as_str(), port)).await.with_context(|| format!("bind {bind}:{port}"))?;
        eprintln!("listening on http://{bind}:{port}");
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = tokio::signal::ctrl_c().await;
                // End the event streams, else they keep the server up until it is killed.
                stopping.send_replace(true); // kept for streams that subscribe after this
            })
            .await?;
        Ok(())
    })
}
