//! Text normalisation shared by the geocoder and by label matching.

/// Lower-case, strip diacritics (ä→a, é→e, ß→ss …) and collapse every run of
/// non-alphanumeric characters into a single space. `"Zürich, Bahnhofstrasse 3a"`
/// becomes `"zurich bahnhofstrasse 3a"`.
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = true;
    for ch in s.chars() {
        let mut push = |c: char, out: &mut String| {
            out.push(c);
        };
        let folded: &str = match ch {
            'ä' | 'à' | 'á' | 'â' | 'ã' | 'å' | 'Ä' | 'À' | 'Á' | 'Â' | 'Ã' | 'Å' => "a",
            'ö' | 'ò' | 'ó' | 'ô' | 'õ' | 'ø' | 'Ö' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ø' => "o",
            'ü' | 'ù' | 'ú' | 'û' | 'Ü' | 'Ù' | 'Ú' | 'Û' => "u",
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => "e",
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => "i",
            'ç' | 'Ç' => "c",
            'ñ' | 'Ñ' => "n",
            'ß' => "ss",
            'æ' | 'Æ' => "ae",
            'œ' | 'Œ' => "oe",
            _ => "",
        };
        if !folded.is_empty() {
            for c in folded.chars() {
                push(c, &mut out);
            }
            space = false;
        } else if ch.is_alphanumeric() {
            for c in ch.to_lowercase() {
                push(c, &mut out);
            }
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn norm() {
        assert_eq!(normalize("Zürich, Bahnhofstrasse 3a"), "zurich bahnhofstrasse 3a");
        assert_eq!(normalize("  Genève-Aéroport "), "geneve aeroport");
        assert_eq!(normalize("Bern, Bärenplatz"), "bern barenplatz");
    }
}
