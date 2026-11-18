// SPDX-License-Identifier: AGPL-3.0-only
//! PDF export for sealoffice: Word, Excel and PowerPoint files laid out by
//! office2pdf (Typst) inside the page, so no document leaves the browser.
//!
//! The layout is Typst's, not the editor's: close to what the editor shows,
//! not identical.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// The OOXML family a file name's extension belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Word,
    Excel,
    PowerPoint,
}

pub const UNSUPPORTED: &str = "PDF export supports Word, Excel and PowerPoint files";

/// Maps an extension (without the dot, any case) to what office2pdf reads.
/// Macro-enabled, template and show variants share their family's package
/// layout; CSV is not a package.
pub fn kind(ext: &str) -> Option<Kind> {
    match ext.to_ascii_lowercase().as_str() {
        "docx" | "docm" | "dotx" | "dotm" => Some(Kind::Word),
        "xlsx" | "xlsm" | "xltx" | "xltm" => Some(Kind::Excel),
        "pptx" | "pptm" | "ppsx" | "ppsm" | "potx" | "potm" => Some(Kind::PowerPoint),
        _ => None,
    }
}

/// Converts the document `bytes`, named with extension `ext`, to PDF bytes.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn to_pdf(bytes: &[u8], ext: &str) -> Result<Vec<u8>, JsError> {
    use office2pdf::config::{ConvertOptions, Format};
    let format = match kind(ext).ok_or_else(|| JsError::new(UNSUPPORTED))? {
        Kind::Word => Format::Docx,
        Kind::Excel => Format::Xlsx,
        Kind::PowerPoint => Format::Pptx,
    };
    office2pdf::convert_bytes(bytes, format, &ConvertOptions::default())
        .map(|result| result.pdf)
        .map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_ooxml_extension() {
        for ext in ["docx", "docm", "dotx", "dotm", "DOCX"] {
            assert_eq!(kind(ext), Some(Kind::Word), "{ext}");
        }
        for ext in ["xlsx", "xlsm", "xltx", "xltm", "Xlsm"] {
            assert_eq!(kind(ext), Some(Kind::Excel), "{ext}");
        }
        for ext in ["pptx", "pptm", "ppsx", "ppsm", "potx", "potm", "PPSX"] {
            assert_eq!(kind(ext), Some(Kind::PowerPoint), "{ext}");
        }
    }

    #[test]
    fn refuses_csv_and_others() {
        for ext in ["csv", "", "pdf", "age", "doc", ".docx"] {
            assert_eq!(kind(ext), None, "{ext}");
        }
    }
}
