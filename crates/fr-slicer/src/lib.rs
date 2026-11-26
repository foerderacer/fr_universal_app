//! Pure-Rust 3D printing slicer core (`fr-slicer`) targeting the **Prusa MK3S**.
//!
//! Invokes an external headless **PrusaSlicer** binary as a separate child process
//! (`--export-gcode --load <composed.ini> --output <out.gcode> <model>`), keeping
//! the workspace UI-agnostic, C++-free, and testable via fake engine binaries.

pub mod engine;
pub mod jobs;
pub mod profiles;
pub mod validate;

pub use engine::{
    PrusaSlicerEngine, SliceEngineRequest, SliceEngineResult, SlicerBinaryInfo,
    SlicerProgressEvent, detect_prusaslicer_binary,
};
pub use jobs::{SliceJobManager, SliceJobRecord, SliceJobState};
pub use profiles::{
    MK3S_BED_X_MM, MK3S_BED_Y_MM, MK3S_BED_Z_MM, MK3S_MAX_BED_TEMP_C, MK3S_MAX_NOZZLE_TEMP_C,
    MK3S_NOZZLE_DIAMETER_MM, MaterialPreset, PrinterSpecs, QualityPreset, QualityPresetInfo,
    RigidityPreset, RigidityPresetInfo, SliceOverrides, SlicerPresetStore, builtin_materials,
    compose_prusaslicer_ini, quality_presets_info, rigidity_presets_info,
};
pub use validate::{
    ALLOWED_FILAMENT_TYPES, MAX_MODEL_BYTES, PlateBoundsMm, SliceValidationRequest,
    estimate_stl_dimensions_mm, sanitize_gcode_filename, validate_material_preset,
    validate_raw_model_fits_mk3s, validate_slice_request,
};
