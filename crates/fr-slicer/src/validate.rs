//! Pre-slice safety validation (bed volume, model format, temperature bounds,
//! nozzle/layer-height compatibility, and safe output filenames).

use fr_core::{FrError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::profiles::{
    MK3S_BED_X_MM, MK3S_BED_Y_MM, MK3S_BED_Z_MM, MK3S_MAX_BED_TEMP_C, MK3S_MAX_NOZZLE_TEMP_C,
    MK3S_MIN_NOZZLE_TEMP_C, MK3S_NOZZLE_DIAMETER_MM, MaterialPreset, QualityPreset,
};

/// Maximum supported STL/3MF plate payload (100 MiB).
pub const MAX_MODEL_BYTES: usize = 100 * 1024 * 1024;
const BED_EPSILON_MM: f64 = 0.5;

/// Axis-aligned bounding box of all models arranged on the MK3S build plate (in mm).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlateBoundsMm {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
    pub min_z: f64,
    pub max_z: f64,
    pub object_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SliceValidationRequest {
    pub file_name: String,
    pub model_size_bytes: u32,
    pub bounds: Option<PlateBoundsMm>,
    pub quality: QualityPreset,
    pub material: MaterialPreset,
}

/// Validates a material preset against Prusa MK3S hardware safety limits.
pub fn validate_material_preset(material: &MaterialPreset) -> Result<()> {
    if material.name.trim().is_empty() {
        return Err(FrError::InvalidInput(
            "Give this material preset a name before saving.".into(),
        ));
    }
    if material.nozzle_temp_c < MK3S_MIN_NOZZLE_TEMP_C
        || material.nozzle_temp_c > MK3S_MAX_NOZZLE_TEMP_C
    {
        return Err(FrError::InvalidInput(format!(
            "Nozzle temperature ({}°C) must be between {}°C and {}°C for a Prusa MK3S.",
            material.nozzle_temp_c, MK3S_MIN_NOZZLE_TEMP_C, MK3S_MAX_NOZZLE_TEMP_C
        )));
    }
    if material.first_layer_nozzle_temp_c < MK3S_MIN_NOZZLE_TEMP_C
        || material.first_layer_nozzle_temp_c > MK3S_MAX_NOZZLE_TEMP_C
    {
        return Err(FrError::InvalidInput(format!(
            "First-layer nozzle temperature ({}°C) must be between {}°C and {}°C for a Prusa MK3S.",
            material.first_layer_nozzle_temp_c, MK3S_MIN_NOZZLE_TEMP_C, MK3S_MAX_NOZZLE_TEMP_C
        )));
    }
    if material.bed_temp_c > MK3S_MAX_BED_TEMP_C {
        return Err(FrError::InvalidInput(format!(
            "Bed temperature ({}°C) exceeds the Prusa MK3S maximum of {}°C.",
            material.bed_temp_c, MK3S_MAX_BED_TEMP_C
        )));
    }
    if material.first_layer_bed_temp_c > MK3S_MAX_BED_TEMP_C {
        return Err(FrError::InvalidInput(format!(
            "First-layer bed temperature ({}°C) exceeds the Prusa MK3S maximum of {}°C.",
            material.first_layer_bed_temp_c, MK3S_MAX_BED_TEMP_C
        )));
    }
    if material.fan_max_percent > 100 || material.fan_min_percent > material.fan_max_percent {
        return Err(FrError::InvalidInput(
            "Cooling fan minimum speed must be less than or equal to maximum speed (0–100%)."
                .into(),
        ));
    }
    if !material.max_volumetric_speed_mm3_s.is_finite()
        || material.max_volumetric_speed_mm3_s <= 0.5
        || material.max_volumetric_speed_mm3_s > 25.0
    {
        return Err(FrError::InvalidInput(
            "Max volumetric speed must be between 0.5 and 25.0 mm³/s.".into(),
        ));
    }
    if !material.extrusion_multiplier.is_finite()
        || material.extrusion_multiplier < 0.7
        || material.extrusion_multiplier > 1.3
    {
        return Err(FrError::InvalidInput(
            "Extrusion multiplier must be between 0.70 and 1.30.".into(),
        ));
    }
    Ok(())
}

/// Validates model format, size, bed volume, nozzle/layer-height compatibility, and temperatures.
pub fn validate_slice_request(req: &SliceValidationRequest) -> Result<()> {
    let lower = req.file_name.trim().to_ascii_lowercase();
    if !(lower.ends_with(".stl") || lower.ends_with(".3mf")) {
        return Err(FrError::InvalidInput(
            "Only STL (.stl) and 3MF (.3mf) 3D models are supported.".into(),
        ));
    }
    if req.model_size_bytes == 0 {
        return Err(FrError::InvalidInput(
            "The model file is empty. Add at least one valid STL or 3MF object to the build plate."
                .into(),
        ));
    }
    if req.model_size_bytes as usize > MAX_MODEL_BYTES {
        return Err(FrError::InvalidInput(
            "The combined model exceeds the 100 MiB slicing limit. Try simplifying the mesh first."
                .into(),
        ));
    }

    let layer_h = req.quality.layer_height_mm();
    let max_layer_h = MK3S_NOZZLE_DIAMETER_MM * 0.80; // 0.32 mm max for 0.4 mm nozzle
    if !(0.05..=max_layer_h).contains(&layer_h) {
        return Err(FrError::InvalidInput(format!(
            "Layer height ({layer_h:.2} mm) is outside the safe range for a {MK3S_NOZZLE_DIAMETER_MM:.1} mm nozzle."
        )));
    }

    validate_material_preset(&req.material)?;

    if let Some(bounds) = &req.bounds {
        if bounds.object_count == 0 {
            return Err(FrError::InvalidInput(
                "Add at least one 3D model to the build plate before slicing.".into(),
            ));
        }
        let coords = [
            bounds.min_x,
            bounds.max_x,
            bounds.min_y,
            bounds.max_y,
            bounds.min_z,
            bounds.max_z,
        ];
        if coords.iter().any(|v| !v.is_finite()) {
            return Err(FrError::InvalidInput(
                "Model dimensions contain invalid numbers. Re-import the file and try again."
                    .into(),
            ));
        }
        let size_x = bounds.max_x - bounds.min_x;
        let size_y = bounds.max_y - bounds.min_y;
        let size_z = bounds.max_z - bounds.min_z;
        if size_x <= 0.1 || size_y <= 0.1 || size_z <= 0.1 {
            return Err(FrError::InvalidInput(
                "The model is too small or flat to print. Check its scale on the build plate."
                    .into(),
            ));
        }
        if bounds.min_x < -BED_EPSILON_MM
            || bounds.max_x > MK3S_BED_X_MM + BED_EPSILON_MM
            || bounds.min_y < -BED_EPSILON_MM
            || bounds.max_y > MK3S_BED_Y_MM + BED_EPSILON_MM
            || bounds.min_z < -BED_EPSILON_MM
            || bounds.max_z > MK3S_BED_Z_MM + BED_EPSILON_MM
        {
            return Err(FrError::InvalidInput(format!(
                "One or more objects sit outside the Prusa MK3S build volume ({MK3S_BED_X_MM:.0} × {MK3S_BED_Y_MM:.0} × {MK3S_BED_Z_MM:.0} mm). Click Auto-arrange or scale down the model so everything fits on the plate."
            )));
        }
    }

    Ok(())
}

/// Sanitizes a model or job name into a safe cross-platform `.gcode` filename.
pub fn sanitize_gcode_filename(raw_name: &str) -> String {
    let base = raw_name
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("print");
    let stem = base
        .strip_suffix(".gcode")
        .or_else(|| base.strip_suffix(".GCODE"))
        .or_else(|| base.strip_suffix(".stl"))
        .or_else(|| base.strip_suffix(".STL"))
        .or_else(|| base.strip_suffix(".3mf"))
        .or_else(|| base.strip_suffix(".3MF"))
        .unwrap_or(base);
    let cleaned: String = stem
        .trim_matches(|c: char| c.is_whitespace() || c == '.')
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut safe = cleaned
        .trim_matches(|c: char| c.is_whitespace() || c == '.')
        .chars()
        .take(96)
        .collect::<String>();
    if safe.is_empty() || safe.chars().all(|c| c == '_') {
        safe = "mk3s_print".into();
    }
    let upper = safe.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        safe.insert(0, '_');
    }
    format!("{safe}.gcode")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::builtin_materials;

    fn sample_bounds() -> PlateBoundsMm {
        PlateBoundsMm {
            min_x: 100.0,
            max_x: 150.0,
            min_y: 80.0,
            max_y: 130.0,
            min_z: 0.0,
            max_z: 40.0,
            object_count: 1,
        }
    }

    #[test]
    fn validates_bed_volume_format_and_temperatures() {
        let pla = builtin_materials()[0].clone();
        let ok_req = SliceValidationRequest {
            file_name: "bracket.stl".into(),
            model_size_bytes: 2048,
            bounds: Some(sample_bounds()),
            quality: QualityPreset::Standard,
            material: pla.clone(),
        };
        assert!(validate_slice_request(&ok_req).is_ok());

        // Unsupported extension rejected
        let mut bad_ext = ok_req.clone();
        bad_ext.file_name = "drawing.pdf".into();
        assert!(validate_slice_request(&bad_ext).is_err());

        // Out of MK3S bed bounds rejected
        let mut too_tall = ok_req.clone();
        too_tall.bounds = Some(PlateBoundsMm {
            max_z: 225.0,
            ..sample_bounds()
        });
        assert!(validate_slice_request(&too_tall).is_err());

        // Excess nozzle temp rejected
        let mut too_hot = ok_req.clone();
        too_hot.material.nozzle_temp_c = 340;
        assert!(validate_slice_request(&too_hot).is_err());

        // Excess bed temp rejected
        let mut hot_bed = ok_req;
        hot_bed.material.bed_temp_c = 135;
        assert!(validate_slice_request(&hot_bed).is_err());
    }

    #[test]
    fn sanitizes_gcode_filenames_cross_platform() {
        assert_eq!(
            sanitize_gcode_filename("../../wing_bracket.stl"),
            "wing_bracket.gcode"
        );
        assert_eq!(sanitize_gcode_filename("CON.3mf"), "_CON.gcode");
        assert_eq!(sanitize_gcode_filename("   ...  "), "mk3s_print.gcode");
    }
}
