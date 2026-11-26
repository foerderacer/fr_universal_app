use serde::{Deserialize, Serialize};
use specta::Type;

/// Capabilities a workspace module can declare to the host shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ModuleCapability {
    Storage,
    Preview,
    McpServerTools,
    McpClient,
    Workflows,
    Chat,
    Slicing,
}

/// Lifecycle state shown in the Workspace Shell sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ModuleStatus {
    Active,
    Preview,
    Planned,
}

/// Serializable metadata describing a registered workspace module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub version: String,
    pub status: ModuleStatus,
    pub capabilities: Vec<ModuleCapability>,
}

/// Contract implemented by every pluggable domain module (`fr-mod-*`).
pub trait FrModule: Send + Sync {
    fn descriptor(&self) -> ModuleDescriptor;
}

/// Registry holding all compiled-in modules in deterministic display order.
#[derive(Default)]
pub struct ModuleRegistry {
    modules: Vec<Box<dyn FrModule>>,
}

impl ModuleRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<M: FrModule + 'static>(&mut self, module: M) {
        self.modules.push(Box::new(module));
    }

    pub fn descriptors(&self) -> Vec<ModuleDescriptor> {
        self.modules.iter().map(|m| m.descriptor()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.modules.is_empty()
    }

    pub fn len(&self) -> usize {
        self.modules.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DummyModule;

    impl FrModule for DummyModule {
        fn descriptor(&self) -> ModuleDescriptor {
            ModuleDescriptor {
                id: "dummy".into(),
                name: "Dummy".into(),
                description: "Test module".into(),
                icon: "box".into(),
                version: "0.1.0".into(),
                status: ModuleStatus::Active,
                capabilities: vec![ModuleCapability::Storage],
            }
        }
    }

    #[test]
    fn registry_lists_registered_modules() {
        let mut reg = ModuleRegistry::new();
        assert!(reg.is_empty());
        reg.register(DummyModule);
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.descriptors()[0].id, "dummy");
    }
}
