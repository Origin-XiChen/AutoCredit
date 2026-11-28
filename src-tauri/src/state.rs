use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::checkin::AdapterContext;
use crate::logger::Logger;
use crate::models::{AppId, BootstrapState, ConfigFile, NetworkStatus, APP_ORDER};
use crate::popup::PopupController;
use crate::store::Store;

pub struct AppState {
    pub store: Mutex<Store>,
    pub logger: Arc<Logger>,
    pub version: String,
    pub is_packaged: bool,
    pub quitting: AtomicBool,
    pub popup: PopupController,
    pub scheduler_lock: tokio::sync::Mutex<()>,
    pub today: Mutex<String>,
    pub network_online: AtomicBool,
    pub network_checked_at: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(store: Store, logger: Arc<Logger>, version: String, is_packaged: bool) -> Self {
        Self {
            store: Mutex::new(store),
            logger,
            version,
            is_packaged,
            quitting: AtomicBool::new(false),
            popup: PopupController::default(),
            scheduler_lock: tokio::sync::Mutex::new(()),
            today: Mutex::new(crate::models::local_date_key()),
            network_online: AtomicBool::new(true),
            network_checked_at: Mutex::new(None),
        }
    }

    pub fn bootstrap(&self) -> BootstrapState {
        let network = NetworkStatus {
            online: self.network_online.load(Ordering::Relaxed),
            checked_at: self
                .network_checked_at
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().cloned()),
        };
        let mut boot = self
            .store
            .lock()
            .map(|store| store.bootstrap(self.version.clone(), self.is_packaged))
            .unwrap_or_else(|_| {
                let fallback = ConfigFile::default();
                BootstrapState {
                    settings: fallback.settings,
                    apps: fallback.apps,
                    runtime: fallback.runtime,
                    metas: APP_ORDER.iter().map(|id| crate::models::app_meta(*id)).collect(),
                    secrets: Default::default(),
                    version: self.version.clone(),
                    data_dir: String::new(),
                    logs_dir: String::new(),
                    is_packaged: self.is_packaged,
                    network: NetworkStatus::default(),
                }
            });
        boot.network = network;
        boot
    }

    pub fn config_snapshot(&self) -> ConfigFile {
        self.store
            .lock()
            .map(|store| store.config.clone())
            .unwrap_or_default()
    }

    pub fn contexts(&self) -> (ConfigFile, Vec<(AppId, AdapterContext)>) {
        match self.store.lock() {
            Ok(store) => {
                let contexts = APP_ORDER
                    .iter()
                    .map(|id| (*id, AdapterContext::from_store(&store, *id)))
                    .collect();
                (store.config.clone(), contexts)
            }
            Err(_) => (ConfigFile::default(), Vec::new()),
        }
    }
}
