//! 3D Printing Slicer domain module (`FrModule`) exposing Prusa MK3S slicing
//! to the desktop workspace shell and built-in local MCP Server.

use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use fr_core::{FrError, FrModule, ModuleCapability, ModuleDescriptor, ModuleStatus, Result};
use fr_mcp::{McpToolHandler, McpToolRegistry};
use fr_slicer::{
    PrinterSpecs, PrusaSlicerEngine, QualityPreset, RigidityPreset, SliceEngineRequest,
    SliceOverrides, SlicerPresetStore, detect_prusaslicer_binary, quality_presets_info,
    rigidity_presets_info, sanitize_gcode_filename,
};
use fr_storage::{CloudPath, StorageBackend};
use serde_json::{Value, json};

/// Pluggable 3D Printing Slicer module registered in [`fr_core::ModuleRegistry`].
#[derive(Debug, Default)]
pub struct SlicerModule;

impl FrModule for SlicerModule {
    fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor {
            id: "slicer".into(),
            name: "3D Slicer".into(),
            description:
                "Prepare STL and 3MF models for the Prusa MK3S with simple Material, Rigidity, and Quality presets."
                    .into(),
            icon: "printer".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            status: ModuleStatus::Active,
            capabilities: vec![
                ModuleCapability::Slicing,
                ModuleCapability::Storage,
                ModuleCapability::McpServerTools,
            ],
        }
    }
}

/// Callback returning the optional user-configured PrusaSlicer binary path.
pub type SlicerPathProvider = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// Registers `slicer_*` tools in the built-in local MCP Server.
pub fn register_slicer_tools(
    registry: &McpToolRegistry,
    preset_store: Arc<SlicerPresetStore>,
    storage: Arc<RwLock<Option<Arc<dyn StorageBackend>>>>,
    binary_path_provider: SlicerPathProvider,
) {
    registry.register(SlicerListPresetsTool(preset_store.clone()));
    registry.register(SlicerSliceCloudModelTool(
        preset_store,
        storage,
        binary_path_provider,
    ));
}

struct SlicerListPresetsTool(Arc<SlicerPresetStore>);

#[async_trait]
impl McpToolHandler for SlicerListPresetsTool {
    fn name(&self) -> &str {
        "slicer_list_presets"
    }
    fn description(&self) -> &str {
        "List available Prusa MK3S printer specs, Rigidity, Quality, and Material presets."
    }
    fn module_id(&self) -> &str {
        "slicer"
    }
    fn is_write(&self) -> bool {
        false
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn summarize_audit(&self, _args: &Value) -> String {
        "List 3D slicer presets".into()
    }
    async fn call(&self, _args: Value) -> Result<Value> {
        let materials = self.0.list_all_materials()?;
        Ok(json!({
            "printer": PrinterSpecs::default(),
            "rigidity": rigidity_presets_info(),
            "quality": quality_presets_info(),
            "materials": materials,
        }))
    }
}

struct SlicerSliceCloudModelTool(
    Arc<SlicerPresetStore>,
    Arc<RwLock<Option<Arc<dyn StorageBackend>>>>,
    SlicerPathProvider,
);

#[async_trait]
impl McpToolHandler for SlicerSliceCloudModelTool {
    fn name(&self) -> &str {
        "slicer_slice_cloud_model"
    }
    fn description(&self) -> &str {
        "Slice an STL or 3MF file stored in Nextcloud for Prusa MK3S and save the resulting .gcode file via StorageBackend (requires user approval)."
    }
    fn module_id(&self) -> &str {
        "slicer"
    }
    fn is_write(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["model_path", "output_folder"],
            "properties": {
                "model_path": { "type": "string", "description": "Nextcloud path to an .stl or .3mf file (e.g. /CAD/bracket.stl)." },
                "output_folder": { "type": "string", "description": "Nextcloud destination folder for the .gcode output (e.g. /3D Prints)." },
                "material_id": { "type": "string", "default": "pla" },
                "rigidity": { "type": "string", "enum": ["low", "medium", "high", "mold"], "default": "medium" },
                "quality": { "type": "string", "enum": ["fine", "standard", "fast"], "default": "standard" },
                "support_material": { "type": "boolean", "default": false }
            }
        })
    }
    fn summarize_audit(&self, args: &Value) -> String {
        let model = args
            .get("model_path")
            .and_then(Value::as_str)
            .unwrap_or("?");
        format!("Slice 3D model {model} for Prusa MK3S")
    }
    fn summarize_approval(&self, args: &Value) -> String {
        let model = args
            .get("model_path")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let folder = args
            .get("output_folder")
            .and_then(Value::as_str)
            .unwrap_or("/");
        format!("Slice '{model}' for Prusa MK3S and save .gcode into '{folder}'")
    }
    async fn call(&self, args: Value) -> Result<Value> {
        let model_path_raw = args
            .get("model_path")
            .and_then(Value::as_str)
            .ok_or_else(|| FrError::InvalidInput("Missing required field 'model_path'.".into()))?;
        let output_folder_raw = args
            .get("output_folder")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                FrError::InvalidInput("Missing required field 'output_folder'.".into())
            })?;
        let material_id = args
            .get("material_id")
            .and_then(Value::as_str)
            .unwrap_or("pla");
        let rigidity: RigidityPreset = args
            .get("rigidity")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default();
        let quality: QualityPreset = args
            .get("quality")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default();
        let support_material = args
            .get("support_material")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let storage = self
            .1
            .read()
            .ok()
            .and_then(|g| g.clone())
            .ok_or_else(|| FrError::AuthRequired("Nextcloud is not signed in.".into()))?;

        let configured = (self.2)();
        let binary = detect_prusaslicer_binary(configured.as_deref()).await;
        let bin_path = binary.path.filter(|_| binary.available).ok_or_else(|| {
            FrError::NotFound("PrusaSlicer is not installed or configured on this computer.".into())
        })?;

        let material = self.0.find_material(material_id)?;
        let model_cloud_path = CloudPath::parse(model_path_raw)?;
        let (model_bytes, _etag) = storage.read(&model_cloud_path).await?;
        let output_name = sanitize_gcode_filename(model_cloud_path.file_name().unwrap_or("print"));
        let folder_path = CloudPath::parse(output_folder_raw)?;
        let output_cloud_path = folder_path.join(&output_name)?;

        let engine = PrusaSlicerEngine::new(bin_path);
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let result = engine
            .run_slice(
                SliceEngineRequest {
                    job_id: "mcp-slice".into(),
                    model_file_name: model_cloud_path
                        .file_name()
                        .unwrap_or("model.stl")
                        .to_owned(),
                    model_bytes,
                    bounds: None,
                    quality,
                    rigidity,
                    material,
                    overrides: SliceOverrides {
                        support_material,
                        brim_width_mm: None,
                    },
                    timeout: fr_slicer::engine::DEFAULT_SLICE_TIMEOUT,
                },
                rx,
                |_| {},
            )
            .await?;

        let _ = storage.mkdir(&folder_path).await;
        storage
            .write(&output_cloud_path, result.gcode_bytes.clone(), None)
            .await?;

        Ok(json!({
            "outputPath": output_cloud_path.as_str(),
            "gcodeSizeBytes": result.gcode_bytes.len(),
            "estimatedTime": result.estimated_time,
            "filamentGrams": result.filament_grams,
            "filamentMm": result.filament_mm,
        }))
    }
}
