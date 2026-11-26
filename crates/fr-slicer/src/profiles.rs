//! Fixed Prusa MK3S machine profile, Rigidity/Quality/Material presets,
//! custom material persistence (with local unsaved draft protection), and
//! deterministic `.ini` composition for PrusaSlicer CLI.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use fr_core::{FrError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use tempfile::NamedTempFile;

use crate::validate::validate_material_preset;

/// Fixed Prusa MK3S build volume and hardware safety bounds.
pub const MK3S_BED_X_MM: f64 = 250.0;
pub const MK3S_BED_Y_MM: f64 = 210.0;
pub const MK3S_BED_Z_MM: f64 = 210.0;
pub const MK3S_NOZZLE_DIAMETER_MM: f64 = 0.4;
pub const MK3S_MAX_NOZZLE_TEMP_C: u16 = 300;
pub const MK3S_MIN_NOZZLE_TEMP_C: u16 = 160;
pub const MK3S_MAX_BED_TEMP_C: u16 = 120;

/// Official Prusa i3 MK3S start G-code (locked; never user free-text in MVP).
const MK3S_START_GCODE: &str = "M862.3 P \"MK3S\" ; printer model check\\nM862.1 P0.4 ; nozzle diameter check\\nM115 U3.13.3 ; tell printer latest fw version\\nG90 ; use absolute coordinates\\nM83 ; extruder relative mode\\nM104 S[first_layer_temperature] ; set extruder temp\\nM140 S[first_layer_bed_temperature] ; set bed temp\\nM190 S[first_layer_bed_temperature] ; wait for bed temp\\nM109 S[first_layer_temperature] ; wait for extruder temp\\nG28 W ; home all without mesh bed level\\nG80 ; mesh bed leveling\\nG1 Z0.2 F720\\nG1 Y-3 F1000 ; go outside print area\\nG92 E0\\nG1 X60 E9 F1000 ; intro line\\nG1 X100 E12.5 F1000 ; intro line\\nG92 E0\\nM221 S95";

/// Official Prusa i3 MK3S end G-code (locked).
const MK3S_END_GCODE: &str = "G4 ; wait\\nM221 S100 ; reset flow\\nM900 K0 ; reset LA\\nM104 S0 ; turn off temperature\\nM140 S0 ; turn off heatbed\\nM107 ; turn off fan\\nG1 Z210 F720 ; raise Z\\nG1 X0 Y200 F3000 ; present print\\nM84 ; disable motors";

/// Fixed target printer metadata exposed to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrinterSpecs {
    pub id: String,
    pub name: String,
    pub bed_x_mm: f64,
    pub bed_y_mm: f64,
    pub bed_z_mm: f64,
    pub nozzle_diameter_mm: f64,
    pub max_nozzle_temp_c: u16,
    pub max_bed_temp_c: u16,
}

impl Default for PrinterSpecs {
    fn default() -> Self {
        Self {
            id: "prusa_mk3s_04".into(),
            name: "Original Prusa i3 MK3S (0.4 mm)".into(),
            bed_x_mm: MK3S_BED_X_MM,
            bed_y_mm: MK3S_BED_Y_MM,
            bed_z_mm: MK3S_BED_Z_MM,
            nozzle_diameter_mm: MK3S_NOZZLE_DIAMETER_MM,
            max_nozzle_temp_c: MK3S_MAX_NOZZLE_TEMP_C,
            max_bed_temp_c: MK3S_MAX_BED_TEMP_C,
        }
    }
}

/// Headline structural preset controlling walls, infill, and shell thickness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RigidityPreset {
    Low,
    #[default]
    Medium,
    High,
    Mold,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RigidityPresetInfo {
    pub id: RigidityPreset,
    pub label: String,
    pub subtitle: String,
    pub perimeters: u8,
    pub fill_density_percent: u8,
    pub top_solid_layers: u8,
    pub bottom_solid_layers: u8,
    pub fill_pattern: String,
}

pub fn rigidity_presets_info() -> Vec<RigidityPresetInfo> {
    vec![
        RigidityPresetInfo {
            id: RigidityPreset::Low,
            label: "Low".into(),
            subtitle: "Fast, lightweight prototypes and visual mockups.".into(),
            perimeters: 2,
            fill_density_percent: 15,
            top_solid_layers: 3,
            bottom_solid_layers: 3,
            fill_pattern: "grid".into(),
        },
        RigidityPresetInfo {
            id: RigidityPreset::Medium,
            label: "Medium".into(),
            subtitle: "Balanced everyday strength and print time (default).".into(),
            perimeters: 3,
            fill_density_percent: 25,
            top_solid_layers: 4,
            bottom_solid_layers: 4,
            fill_pattern: "gyroid".into(),
        },
        RigidityPresetInfo {
            id: RigidityPreset::High,
            label: "High".into(),
            subtitle: "Heavy-duty structural brackets, mounts, and fixtures.".into(),
            perimeters: 4,
            fill_density_percent: 50,
            top_solid_layers: 5,
            bottom_solid_layers: 5,
            fill_pattern: "gyroid".into(),
        },
        RigidityPresetInfo {
            id: RigidityPreset::Mold,
            label: "Mold".into(),
            subtitle: "Dense, leak-resistant shells tuned for casting molds.".into(),
            perimeters: 5,
            fill_density_percent: 95,
            top_solid_layers: 6,
            bottom_solid_layers: 6,
            fill_pattern: "rectilinear".into(),
        },
    ]
}

/// Three fixed quality choices (raw mm numbers are kept out of the primary UX).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QualityPreset {
    Fine,
    #[default]
    Standard,
    Fast,
}

impl QualityPreset {
    pub fn layer_height_mm(self) -> f64 {
        match self {
            QualityPreset::Fine => 0.10,
            QualityPreset::Standard => 0.20,
            QualityPreset::Fast => 0.30,
        }
    }

    pub fn first_layer_height_mm(self) -> f64 {
        0.20
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QualityPresetInfo {
    pub id: QualityPreset,
    pub label: String,
    pub subtitle: String,
    pub layer_height_mm: f64,
}

pub fn quality_presets_info() -> Vec<QualityPresetInfo> {
    vec![
        QualityPresetInfo {
            id: QualityPreset::Fine,
            label: "Fine".into(),
            subtitle: "Smooth surfaces and crisp small details; slower print.".into(),
            layer_height_mm: QualityPreset::Fine.layer_height_mm(),
        },
        QualityPresetInfo {
            id: QualityPreset::Standard,
            label: "Standard".into(),
            subtitle: "Great detail and dependable speed for most parts.".into(),
            layer_height_mm: QualityPreset::Standard.layer_height_mm(),
        },
        QualityPresetInfo {
            id: QualityPreset::Fast,
            label: "Fast".into(),
            subtitle: "Quick draft iterations and large functional parts.".into(),
            layer_height_mm: QualityPreset::Fast.layer_height_mm(),
        },
    ]
}

/// Filament preset (built-in or user-created custom material).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MaterialPreset {
    pub id: String,
    pub name: String,
    pub filament_type: String,
    pub built_in: bool,
    pub nozzle_temp_c: u16,
    pub first_layer_nozzle_temp_c: u16,
    pub bed_temp_c: u16,
    pub first_layer_bed_temp_c: u16,
    pub fan_min_percent: u8,
    pub fan_max_percent: u8,
    pub disable_fan_first_layers: u8,
    pub max_volumetric_speed_mm3_s: f64,
    pub extrusion_multiplier: f64,
    #[serde(default)]
    pub hint: Option<String>,
}

/// Built-in official MK3S starting material presets (PLA, PETG, ABS, TPU).
pub fn builtin_materials() -> Vec<MaterialPreset> {
    vec![
        MaterialPreset {
            id: "pla".into(),
            name: "PLA".into(),
            filament_type: "PLA".into(),
            built_in: true,
            nozzle_temp_c: 215,
            first_layer_nozzle_temp_c: 215,
            bed_temp_c: 60,
            first_layer_bed_temp_c: 60,
            fan_min_percent: 100,
            fan_max_percent: 100,
            disable_fan_first_layers: 1,
            max_volumetric_speed_mm3_s: 15.0,
            extrusion_multiplier: 1.0,
            hint: None,
        },
        MaterialPreset {
            id: "petg".into(),
            name: "PETG".into(),
            filament_type: "PETG".into(),
            built_in: true,
            nozzle_temp_c: 240,
            first_layer_nozzle_temp_c: 230,
            bed_temp_c: 90,
            first_layer_bed_temp_c: 85,
            fan_min_percent: 30,
            fan_max_percent: 50,
            disable_fan_first_layers: 3,
            max_volumetric_speed_mm3_s: 8.0,
            extrusion_multiplier: 1.0,
            hint: Some(
                "Use a textured steel sheet (or a light layer of glue stick on a smooth sheet) so PETG releases cleanly."
                    .into(),
            ),
        },
        MaterialPreset {
            id: "abs".into(),
            name: "ABS".into(),
            filament_type: "ABS".into(),
            built_in: true,
            nozzle_temp_c: 255,
            first_layer_nozzle_temp_c: 255,
            bed_temp_c: 100,
            first_layer_bed_temp_c: 100,
            fan_min_percent: 15,
            fan_max_percent: 30,
            disable_fan_first_layers: 4,
            max_volumetric_speed_mm3_s: 11.0,
            extrusion_multiplier: 1.0,
            hint: Some(
                "ABS is draft-sensitive on an open-frame Prusa MK3S and can warp without an enclosure. Print in a draft-free, well-ventilated space."
                    .into(),
            ),
        },
        MaterialPreset {
            id: "tpu".into(),
            name: "TPU".into(),
            filament_type: "FLEX".into(),
            built_in: true,
            nozzle_temp_c: 230,
            first_layer_nozzle_temp_c: 230,
            bed_temp_c: 50,
            first_layer_bed_temp_c: 50,
            fan_min_percent: 70,
            fan_max_percent: 90,
            disable_fan_first_layers: 3,
            max_volumetric_speed_mm3_s: 2.5,
            extrusion_multiplier: 1.05,
            hint: Some(
                "Flexible filament prints slowly to avoid extruder jams. Loosen the idler tension slightly and keep TPU dry."
                    .into(),
            ),
        },
    ]
}

/// Safe optional overrides that never touch locked machine start/end G-code.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SliceOverrides {
    #[serde(default)]
    pub support_material: bool,
    #[serde(default)]
    pub brim_width_mm: Option<f64>,
}

/// Composes a single flat PrusaSlicer `.ini` config bundle following strict precedence:
/// `printer.ini (fixed MK3S) ← quality preset ← rigidity preset ← material preset ← user overrides`.
///
/// Start/end G-code and hardware limits are locked to official Prusa MK3S values.
pub fn compose_prusaslicer_ini(
    quality: QualityPreset,
    rigidity: RigidityPreset,
    material: &MaterialPreset,
    overrides: &SliceOverrides,
) -> String {
    let mut kv: BTreeMap<&'static str, String> = BTreeMap::new();

    // 1. Fixed Prusa MK3S printer profile (0.4 mm nozzle, 250x210x210 mm)
    kv.insert("printer_model", "MK3S".into());
    kv.insert("gcode_flavor", "marlin2".into());
    kv.insert("bed_shape", "0x0,250x0,250x210,0x210".into());
    kv.insert("max_print_height", "210".into());
    kv.insert("nozzle_diameter", format!("{MK3S_NOZZLE_DIAMETER_MM:.1}"));
    kv.insert("filament_diameter", "1.75".into());
    kv.insert("use_relative_e_distances", "1".into());
    kv.insert("retract_length", "0.8".into());
    kv.insert("retract_speed", "35".into());
    kv.insert("retract_lift", "0.4".into());
    kv.insert("skirt_loops", "1".into());
    kv.insert("skirt_distance", "2".into());
    kv.insert("skirt_height", "1".into());
    kv.insert("perimeter_speed", "45".into());
    kv.insert("external_perimeter_speed", "25".into());
    kv.insert("infill_speed", "80".into());
    kv.insert("solid_infill_speed", "80".into());
    kv.insert("top_solid_infill_speed", "40".into());
    kv.insert("travel_speed", "180".into());
    kv.insert("first_layer_speed", "20".into());
    kv.insert("extrusion_width", "0.45".into());
    kv.insert("first_layer_extrusion_width", "0.42".into());
    kv.insert("perimeter_extrusion_width", "0.45".into());
    kv.insert("external_perimeter_extrusion_width", "0.45".into());
    kv.insert("infill_extrusion_width", "0.45".into());
    kv.insert("solid_infill_extrusion_width", "0.45".into());
    kv.insert("top_infill_extrusion_width", "0.4".into());
    kv.insert("start_gcode", MK3S_START_GCODE.into());
    kv.insert("end_gcode", MK3S_END_GCODE.into());
    // Required by PrusaSlicer whenever `use_relative_e_distances = 1` (official MK3S profile).
    kv.insert("layer_gcode", "G92 E0".into());

    // 2. Quality preset (layer height)
    kv.insert("layer_height", format!("{:.2}", quality.layer_height_mm()));
    kv.insert(
        "first_layer_height",
        format!("{:.2}", quality.first_layer_height_mm()),
    );
    match quality {
        QualityPreset::Fine => {
            kv.insert("external_perimeter_speed", "25".into());
            kv.insert("perimeter_speed", "40".into());
        }
        QualityPreset::Standard => {
            kv.insert("external_perimeter_speed", "30".into());
            kv.insert("perimeter_speed", "45".into());
        }
        QualityPreset::Fast => {
            kv.insert("external_perimeter_speed", "35".into());
            kv.insert("perimeter_speed", "50".into());
            kv.insert("infill_speed", "100".into());
        }
    }

    // 3. Rigidity preset (headline structural settings)
    let rigidity_info = rigidity_presets_info()
        .into_iter()
        .find(|r| r.id == rigidity)
        .expect("all rigidity variants exist");
    kv.insert("perimeters", rigidity_info.perimeters.to_string());
    kv.insert(
        "fill_density",
        format!("{}%", rigidity_info.fill_density_percent),
    );
    kv.insert("fill_pattern", rigidity_info.fill_pattern);
    kv.insert(
        "top_solid_layers",
        rigidity_info.top_solid_layers.to_string(),
    );
    kv.insert(
        "bottom_solid_layers",
        rigidity_info.bottom_solid_layers.to_string(),
    );
    if rigidity == RigidityPreset::Mold {
        kv.insert("avoid_crossing_perimeters", "1".into());
        kv.insert("ensure_vertical_shell_thickness", "1".into());
        kv.insert("seam_position", "aligned".into());
        kv.insert("top_fill_pattern", "monotonic".into());
    }

    // 4. Material preset (temperatures, cooling, volumetric limit)
    // Sanitize filament_type against INI injection even if called directly without validate().
    let safe_filament_type = match material.filament_type.trim() {
        "PLA" => "PLA",
        "PETG" => "PETG",
        "ABS" => "ABS",
        "FLEX" => "FLEX",
        _ => "PLA",
    };
    kv.insert("filament_type", safe_filament_type.to_owned());
    let filament_density = match safe_filament_type {
        "PETG" => "1.27",
        "ABS" => "1.04",
        "FLEX" => "1.21",
        _ => "1.24",
    };
    kv.insert("filament_density", filament_density.to_owned());
    kv.insert("temperature", material.nozzle_temp_c.to_string());
    kv.insert(
        "first_layer_temperature",
        material.first_layer_nozzle_temp_c.to_string(),
    );
    kv.insert("bed_temperature", material.bed_temp_c.to_string());
    kv.insert(
        "first_layer_bed_temperature",
        material.first_layer_bed_temp_c.to_string(),
    );
    kv.insert("min_fan_speed", material.fan_min_percent.to_string());
    kv.insert("max_fan_speed", material.fan_max_percent.to_string());
    kv.insert("cooling", "1".into());
    kv.insert(
        "disable_fan_first_layers",
        material.disable_fan_first_layers.to_string(),
    );
    kv.insert(
        "filament_max_volumetric_speed",
        format!("{:.2}", material.max_volumetric_speed_mm3_s),
    );
    kv.insert(
        "extrusion_multiplier",
        format!("{:.3}", material.extrusion_multiplier),
    );
    if material.filament_type.eq_ignore_ascii_case("FLEX") {
        // Slower safe speeds for flexible TPU on MK3S direct-drive extruder.
        kv.insert("perimeter_speed", "25".into());
        kv.insert("external_perimeter_speed", "20".into());
        kv.insert("infill_speed", "25".into());
        kv.insert("solid_infill_speed", "25".into());
        kv.insert("top_solid_infill_speed", "20".into());
        kv.insert("first_layer_speed", "15".into());
        kv.insert("retract_lift", "0".into());
    }

    // 5. Safe user overrides (support & brim only; start/end G-code remain locked)
    kv.insert(
        "support_material",
        if overrides.support_material { "1" } else { "0" }.into(),
    );
    if overrides.support_material {
        kv.insert("support_material_auto", "1".into());
        kv.insert("support_material_buildplate_only", "1".into());
        kv.insert("support_material_contact_distance", "0.2".into());
    }
    let brim = overrides.brim_width_mm.unwrap_or(0.0).clamp(0.0, 20.0);
    kv.insert("brim_width", format!("{brim:.1}"));

    let mut out = String::from(
        "# Generated by FR Universal App (fr-slicer) — Prusa MK3S (0.4 mm nozzle)\n\
         # Precedence: MK3S base <- quality <- rigidity <- material <- overrides\n",
    );
    for (k, v) in kv {
        out.push_str(k);
        out.push_str(" = ");
        out.push_str(&v);
        out.push('\n');
    }
    out
}

/// Persisted custom material presets and unsaved draft state.
#[derive(Debug, Clone)]
pub struct SlicerPresetStore {
    presets_path: PathBuf,
    draft_path: PathBuf,
}

impl SlicerPresetStore {
    pub fn from_dir(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        Self {
            presets_path: dir.join("slicer-materials.json"),
            draft_path: dir.join("slicer-material-draft.json"),
        }
    }

    pub fn default_location() -> Result<Self> {
        let proj_dirs =
            ProjectDirs::from("de", "foerderacer", "FRUniversalApp").ok_or_else(|| {
                FrError::InvalidConfig("unable to resolve OS config directory".into())
            })?;
        Ok(Self::from_dir(proj_dirs.config_dir()))
    }

    pub fn list_custom_materials(&self) -> Result<Vec<MaterialPreset>> {
        let raw = match fs::read_to_string(&self.presets_path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(FrError::Io(err)),
        };
        let mut items: Vec<MaterialPreset> = serde_json::from_str(&raw)?;
        for item in &mut items {
            item.built_in = false;
        }
        items.sort_by_key(|a| a.name.to_lowercase());
        Ok(items)
    }

    pub fn list_all_materials(&self) -> Result<Vec<MaterialPreset>> {
        let mut all = builtin_materials();
        all.extend(self.list_custom_materials()?);
        Ok(all)
    }

    pub fn find_material(&self, id: &str) -> Result<MaterialPreset> {
        self.list_all_materials()?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| FrError::NotFound(format!("Material preset '{id}' was not found.")))
    }

    pub fn save_custom_material(&self, mut preset: MaterialPreset) -> Result<MaterialPreset> {
        let builtins = builtin_materials();
        preset.built_in = false;
        preset.name = preset.name.trim().to_owned();
        preset.filament_type = preset.filament_type.trim().to_ascii_uppercase();
        if preset.filament_type.is_empty() {
            preset.filament_type = "PLA".into();
        }

        // Generate a clean non-builtin ID when creating a new preset or duplicating a built-in,
        // keeping total length <= 48 chars so subsequent edits preserve the exact ID.
        let clean_id = slugify_id(&preset.id, 64);
        if clean_id.is_empty() || builtins.iter().any(|b| b.id == clean_id) {
            let base = slugify_id(&preset.name, 34);
            let suffix = &uuid::Uuid::new_v4().simple().to_string()[..6];
            preset.id = if base.is_empty() {
                format!("custom-{suffix}")
            } else {
                format!("custom-{base}-{suffix}")
            };
        } else {
            preset.id = clean_id;
        }

        validate_material_preset(&preset)?;

        let mut list = self.list_custom_materials()?;
        if let Some(existing) = list.iter_mut().find(|m| m.id == preset.id) {
            *existing = preset.clone();
        } else {
            list.push(preset.clone());
        }
        write_json_atomic(&self.presets_path, &list)?;
        let _ = self.clear_material_draft();
        Ok(preset)
    }

    pub fn delete_custom_material(&self, id: &str) -> Result<()> {
        if builtin_materials().iter().any(|b| b.id == id) {
            return Err(FrError::InvalidInput(
                "Built-in material presets cannot be deleted. You can duplicate and customize them instead."
                    .into(),
            ));
        }
        let mut list = self.list_custom_materials()?;
        let before = list.len();
        list.retain(|m| m.id != id);
        if list.len() == before {
            return Err(FrError::NotFound(format!(
                "Custom material preset '{id}' was not found."
            )));
        }
        write_json_atomic(&self.presets_path, &list)?;
        Ok(())
    }

    pub fn get_material_draft(&self) -> Result<Option<MaterialPreset>> {
        let raw = match fs::read_to_string(&self.draft_path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(FrError::Io(err)),
        };
        let draft: MaterialPreset = serde_json::from_str(&raw)?;
        Ok(Some(draft))
    }

    pub fn save_material_draft(&self, draft: &MaterialPreset) -> Result<()> {
        write_json_atomic(&self.draft_path, draft)
    }

    pub fn clear_material_draft(&self) -> Result<()> {
        match fs::remove_file(&self.draft_path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(FrError::Io(err)),
        }
    }

    pub fn has_material_draft(&self) -> bool {
        self.get_material_draft().ok().flatten().is_some()
    }
}

fn slugify_id(raw: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if (ch == '-' || ch == '_' || ch.is_whitespace()) && !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-')
        .chars()
        .take(max_len)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned()
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let json = serde_json::to_string_pretty(value)?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.write_all(json.as_bytes())?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|err| FrError::Io(err.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn golden_ini_composition_matches_precedence_and_locks_start_gcode() {
        let pla = builtin_materials()
            .into_iter()
            .find(|m| m.id == "pla")
            .unwrap();
        let ini_medium = compose_prusaslicer_ini(
            QualityPreset::Standard,
            RigidityPreset::Medium,
            &pla,
            &SliceOverrides::default(),
        );
        assert!(ini_medium.contains("printer_model = MK3S\n"));
        assert!(ini_medium.contains("bed_shape = 0x0,250x0,250x210,0x210\n"));
        assert!(ini_medium.contains("nozzle_diameter = 0.4\n"));
        assert!(ini_medium.contains("layer_height = 0.20\n"));
        assert!(ini_medium.contains("perimeters = 3\n"));
        assert!(ini_medium.contains("fill_density = 25%\n"));
        assert!(ini_medium.contains("fill_pattern = gyroid\n"));
        assert!(ini_medium.contains("top_solid_layers = 4\n"));
        assert!(ini_medium.contains("bottom_solid_layers = 4\n"));
        assert!(ini_medium.contains("temperature = 215\n"));
        assert!(ini_medium.contains("bed_temperature = 60\n"));
        assert!(ini_medium.contains("support_material = 0\n"));
        assert!(ini_medium.contains("start_gcode = M862.3 P \"MK3S\""));
        assert!(ini_medium.contains("layer_gcode = G92 E0\n"));
        assert!(ini_medium.contains("gcode_flavor = marlin2\n"));

        // Mold preset + Fine quality + ABS + supports + brim
        let abs = builtin_materials()
            .into_iter()
            .find(|m| m.id == "abs")
            .unwrap();
        assert!(
            abs.hint
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .contains("enclosure")
        );
        let ini_mold = compose_prusaslicer_ini(
            QualityPreset::Fine,
            RigidityPreset::Mold,
            &abs,
            &SliceOverrides {
                support_material: true,
                brim_width_mm: Some(5.0),
            },
        );
        assert!(ini_mold.contains("layer_height = 0.10\n"));
        assert!(ini_mold.contains("perimeters = 5\n"));
        assert!(ini_mold.contains("fill_density = 95%\n"));
        assert!(ini_mold.contains("top_solid_layers = 6\n"));
        assert!(ini_mold.contains("bottom_solid_layers = 6\n"));
        assert!(ini_mold.contains("avoid_crossing_perimeters = 1\n"));
        assert!(ini_mold.contains("temperature = 255\n"));
        assert!(ini_mold.contains("bed_temperature = 100\n"));
        assert!(ini_mold.contains("support_material = 1\n"));
        assert!(ini_mold.contains("brim_width = 5.0\n"));

        // TPU overrides speeds down safely even on Fast quality
        let tpu = builtin_materials()
            .into_iter()
            .find(|m| m.id == "tpu")
            .unwrap();
        let ini_tpu = compose_prusaslicer_ini(
            QualityPreset::Fast,
            RigidityPreset::Low,
            &tpu,
            &SliceOverrides::default(),
        );
        assert!(ini_tpu.contains("layer_height = 0.30\n"));
        assert!(ini_tpu.contains("perimeters = 2\n"));
        assert!(ini_tpu.contains("fill_density = 15%\n"));
        assert!(ini_tpu.contains("infill_speed = 25\n"));
        assert!(ini_tpu.contains("filament_max_volumetric_speed = 2.50\n"));
    }

    #[test]
    fn custom_material_store_persists_and_protects_drafts() {
        let dir = tempdir().unwrap();
        let store = SlicerPresetStore::from_dir(dir.path());
        assert_eq!(store.list_all_materials().unwrap().len(), 4);

        let mut custom = builtin_materials()[0].clone();
        custom.id = "pla".into(); // collides with builtin -> auto-gets custom-* id
        custom.name = "Team Carbon PETG".into();
        custom.filament_type = "PETG".into();
        custom.nozzle_temp_c = 245;
        custom.bed_temp_c = 85;

        // Save draft first
        store.save_material_draft(&custom).unwrap();
        assert!(store.has_material_draft());
        assert_eq!(
            store.get_material_draft().unwrap().unwrap().name,
            "Team Carbon PETG"
        );

        // Saving custom material persists it and clears draft
        let mut long_custom = custom;
        long_custom.name = "Prusament PETG Carbon Fiber Matte Black Formula Student Edition".into();
        let saved = store.save_custom_material(long_custom).unwrap();
        assert!(saved.id.starts_with("custom-prusament-petg-"));
        assert!(saved.id.len() <= 48);
        assert!(!saved.built_in);
        assert!(!store.has_material_draft());
        assert_eq!(store.list_all_materials().unwrap().len(), 5);

        // Editing the same long-named preset updates in place instead of duplicating.
        let mut edited = saved.clone();
        edited.nozzle_temp_c = 250;
        let saved_again = store.save_custom_material(edited).unwrap();
        assert_eq!(saved_again.id, saved.id);
        assert_eq!(store.list_all_materials().unwrap().len(), 5);

        // Builtins cannot be deleted
        assert!(store.delete_custom_material("pla").is_err());

        // Custom can be deleted
        store.delete_custom_material(&saved.id).unwrap();
        assert_eq!(store.list_all_materials().unwrap().len(), 4);
    }
}
