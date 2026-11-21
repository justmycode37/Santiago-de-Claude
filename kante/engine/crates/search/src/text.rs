//! Canonical search tokens, the alias table and the one-edit matcher.
//!
//! A *canonical token* is what both the index and the query are reduced to:
//! `core::text::normalize` (lower case, no diacritics, punctuation → space),
//! then per word
//! - `ae`/`oe`/`ue` → `a`/`o`/`u`, so "Zuerich", "Zürich" and "Zurich" are one
//!   token. The fold is applied to every word on both sides, so it never
//!   breaks a match and it keeps prefixes prefixes ("zue" → "zu");
//! - `sankt`/`saint` → `st`, `sainte` → `ste`;
//! - `str` → `strasse`, `…str` → `…strasse`.
//!
//! Words that start with a digit (house numbers, postcodes) are left alone.

use kante_core::text::normalize;
use std::sync::OnceLock;

/// A list of tokens stored back to back in one buffer.
#[derive(Default, Clone)]
pub struct Toks {
    pub buf: String,
    pub spans: Vec<(u32, u32)>,
}

impl Toks {
    pub fn clear(&mut self) {
        self.buf.clear();
        self.spans.clear();
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.spans.len()
    }
    #[inline]
    pub fn get(&self, i: usize) -> &str {
        let (a, b) = self.spans[i];
        &self.buf[a as usize..b as usize]
    }
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        (0..self.len()).map(move |i| self.get(i))
    }
    fn push_with(&mut self, f: impl FnOnce(&mut String)) {
        let a = self.buf.len() as u32;
        f(&mut self.buf);
        let b = self.buf.len() as u32;
        if b > a {
            self.spans.push((a, b));
        }
    }
}

/// Append the vowel-folded form of one normalised word.
pub fn fold_word(word: &str, out: &mut String) {
    if word.as_bytes().first().is_some_and(|b| b.is_ascii_digit()) {
        out.push_str(word);
        return;
    }
    let mut it = word.chars().peekable();
    while let Some(c) = it.next() {
        out.push(c);
        if matches!(c, 'a' | 'o' | 'u') && it.peek() == Some(&'e') {
            it.next();
        }
    }
}

/// Whole-word rewrites applied to index tokens and to completed query tokens.
fn canon_in_place(out: &mut String, start: usize) {
    let w = &out[start..];
    let rep = match w {
        "sankt" | "saint" => Some("st"),
        "sainte" => Some("ste"),
        "str" => Some("strasse"),
        _ => None,
    };
    if let Some(r) = rep {
        out.truncate(start);
        out.push_str(r);
    } else if w.len() >= 6 && w.ends_with("str") {
        out.push_str("asse");
    }
}

/// "McDonald's" is one word: drop an apostrophe that sits between a letter
/// and a final `s`. Other apostrophes ("L'Isle", "d'Or") keep splitting words.
fn prep(s: &str) -> std::borrow::Cow<'_, str> {
    const APOS: [char; 4] = ['\'', '’', '`', '´'];
    if !s.contains(APOS) {
        return std::borrow::Cow::Borrowed(s);
    }
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        let genitive = APOS.contains(&c)
            && i > 0
            && chars[i - 1].is_alphabetic()
            && matches!(chars.get(i + 1), Some('s' | 'S'))
            && !chars.get(i + 2).is_some_and(|n| n.is_alphanumeric());
        if !genitive {
            out.push(c);
        }
    }
    std::borrow::Cow::Owned(out)
}

/// Words that carry no meaning of their own in a name ("Château *de* Chillon").
pub fn is_minor(tok: &str) -> bool {
    matches!(
        tok,
        "de" | "du" | "des" | "la" | "le" | "les" | "l" | "d" | "der" | "die" | "das" | "den" | "dem" | "von" | "vom" | "zum" | "zur" | "am" | "an" | "im"
            | "in" | "auf" | "bei" | "of" | "the" | "di" | "del" | "della" | "dei" | "da" | "al" | "alla" | "sur" | "sous" | "en" | "et" | "und" | "e" | "a" | "ob"
    )
}

/// Canonical tokens of `s` (index side, and query tokens that are complete).
pub fn tokenize_into(s: &str, out: &mut Toks) {
    let n = normalize(&prep(s));
    for w in n.split(' ') {
        if w.is_empty() {
            continue;
        }
        out.push_with(|buf| {
            let start = buf.len();
            fold_word(w, buf);
            canon_in_place(buf, start);
        });
    }
}

/// Query tokens: like [`tokenize_into`], but the last word is only folded —
/// it is still being typed ("str" may become "strand"), so the whole-word
/// rewrites are offered as alternatives through the alias table instead.
pub fn tokenize_query(s: &str, out: &mut Toks) {
    let n = normalize(&prep(s));
    let n_words = n.split(' ').filter(|w| !w.is_empty()).count();
    for (i, w) in n.split(' ').filter(|w| !w.is_empty()).enumerate() {
        let last = i + 1 == n_words;
        out.push_with(|buf| {
            let start = buf.len();
            fold_word(w, buf);
            if !last {
                canon_in_place(buf, start);
            }
        });
    }
}

pub fn tokens(s: &str) -> Vec<String> {
    let mut t = Toks::default();
    tokenize_into(s, &mut t);
    t.iter().map(|x| x.to_string()).collect()
}

/// (what people type, what the data says). Both sides are folded at start-up.
const ALIASES: &[(&str, &str)] = &[
    // whole-word rewrites, for the token that is still being typed
    ("sankt", "st"),
    ("saint", "st"),
    ("sainte", "ste"),
    ("str", "strasse"),
    // stations
    ("hbf", "hb"),
    ("hauptbahnhof", "hb"),
    ("bhf", "bahnhof"),
    ("airport", "flughafen"),
    ("airport", "aeroport"),
    ("airport", "aeroporto"),
    ("flughafen", "aeroport"),
    ("aeroport", "flughafen"),
    // exonyms
    ("genf", "geneve"),
    ("geneva", "geneve"),
    ("ginevra", "geneve"),
    ("bale", "basel"),
    ("basle", "basel"),
    ("basilea", "basel"),
    ("berne", "bern"),
    ("berna", "bern"),
    ("zurigo", "zurich"),
    ("lucerne", "luzern"),
    ("lucerna", "luzern"),
    ("losanna", "lausanne"),
    ("neuenburg", "neuchatel"),
    ("freiburg", "fribourg"),
    ("friburgo", "fribourg"),
    ("sitten", "sion"),
    ("siders", "sierre"),
    ("coira", "chur"),
    ("coire", "chur"),
    ("soleure", "solothurn"),
    ("soletta", "solothurn"),
    ("schaffhouse", "schaffhausen"),
    ("sciaffusa", "schaffhausen"),
    ("delsberg", "delemont"),
    ("pruntrut", "porrentruy"),
    ("morat", "murten"),
    ("martinach", "martigny"),
    ("bienne", "biel"),
    ("winterthour", "winterthur"),
    ("lugano", "lugano"),
    // street abbreviations
    ("av", "avenue"),
    ("ave", "avenue"),
    ("ch", "chemin"),
    ("rte", "route"),
    ("bd", "boulevard"),
    ("bvd", "boulevard"),
    ("boul", "boulevard"),
    ("pl", "place"),
    ("pl", "platz"),
    ("imp", "impasse"),
];

pub fn aliases() -> &'static [(String, String)] {
    static T: OnceLock<Vec<(String, String)>> = OnceLock::new();
    T.get_or_init(|| {
        ALIASES
            .iter()
            .filter(|(a, b)| a != b)
            .map(|(a, b)| {
                let (mut x, mut y) = (String::new(), String::new());
                fold_word(a, &mut x);
                fold_word(b, &mut y);
                (x, y)
            })
            .collect()
    })
}

/// Is `t` — or, with `prefix`, some prefix of `t` — within one edit
/// (insert, delete, substitute, transpose two neighbours) of `q`?
///
/// In prefix mode the edit must be followed by at least one more typed
/// character, otherwise every term sharing all but the last letter would match.
pub fn within1(q: &[u8], t: &[u8], prefix: bool) -> bool {
    let n = q.len();
    let mut i = 0;
    while i < n && i < t.len() && q[i] == t[i] {
        i += 1;
    }
    if i == n {
        return prefix || t.len() <= n + 1;
    }
    if prefix && i + 1 >= n {
        return false;
    }
    if i == t.len() {
        return n - i <= 1;
    }
    let (qr, tr) = (&q[i..], &t[i..]);
    let eq = |a: &[u8], b: &[u8]| if prefix { b.len() >= a.len() && &b[..a.len()] == a } else { a == b };
    eq(&qr[1..], &tr[1..])
        || eq(&qr[1..], tr)
        || eq(qr, &tr[1..])
        || (qr.len() >= 2 && tr.len() >= 2 && qr[0] == tr[1] && qr[1] == tr[0] && eq(&qr[2..], &tr[2..]))
}

/// Does this canonical token look like a house number ("3", "12a", "7bis")?
pub fn is_house_number(t: &str) -> bool {
    let b = t.as_bytes();
    if b.is_empty() || b.len() > 7 || !b[0].is_ascii_digit() {
        return false;
    }
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    digits <= 4 && b.len() - digits <= 3 && b[digits..].iter().all(|c| c.is_ascii_lowercase())
}

/// Leading integer of a house-number key ("12a" → 12); `u32::MAX` if none.
pub fn leading_int(s: &str) -> u32 {
    let d = s.bytes().take_while(|c| c.is_ascii_digit()).count();
    if d == 0 || d > 8 {
        return u32::MAX;
    }
    s[..d].parse().unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_tokens() {
        assert_eq!(tokens("Zürich, Bahnhofstr. 3a"), ["zurich", "bahnhofstrasse", "3a"]);
        assert_eq!(tokens("Zuerich HB"), ["zurich", "hb"]);
        assert_eq!(tokens("Sankt Gallen"), ["st", "gallen"]);
        assert_eq!(tokens("St. Gallen"), ["st", "gallen"]);
        assert_eq!(tokens("Saint-Imier"), ["st", "imier"]);
        assert_eq!(tokens("Zürcher Str."), ["zurcher", "strasse"]);
        assert_eq!(tokens("Rue du Mont-Blanc"), ["ru", "du", "mont", "blanc"]);
        assert_eq!(tokens("Oerlikon"), tokens("Örlikon"));
        // The fold is blind ("aé" → "ae" → "a"), but it is the same on both sides.
        assert_eq!(tokens("Genève-Aéroport"), ["geneve", "aroport"]);
        assert_eq!(tokens("geneve aeroport"), ["geneve", "aroport"]);
        assert_eq!(tokens("McDonald's"), ["mcdonalds"]);
        assert_eq!(tokens("McDonald’s Bern"), ["mcdonalds", "bern"]);
        assert_eq!(tokens("L'Isle d'Or"), ["l", "isle", "d", "or"]);
    }

    #[test]
    fn query_keeps_last_word_open() {
        let mut t = Toks::default();
        tokenize_query("bahnhofstr str", &mut t);
        assert_eq!(t.iter().collect::<Vec<_>>(), ["bahnhofstrasse", "str"]);
        t.clear();
        tokenize_query("zue", &mut t);
        assert_eq!(t.get(0), "zu");
    }

    #[test]
    fn one_edit() {
        let w = |a: &str, b: &str, p| within1(a.as_bytes(), b.as_bytes(), p);
        assert!(w("hirschengrabn", "hirschengraben", false)); // missing letter
        assert!(w("hirschengrabenn", "hirschengraben", false)); // extra letter
        assert!(w("hirschengrabem", "hirschengraben", false)); // wrong letter
        assert!(w("hirschengarben", "hirschengraben", false)); // swapped
        assert!(w("xirschengraben", "hirschengraben", false));
        assert!(!w("hirschngrabn", "hirschengraben", false)); // two edits
        assert!(!w("hirsch", "hirschengraben", false));
        assert!(w("hirshen", "hirschengraben", true)); // typo, then still typing
        assert!(!w("hirschx", "hirschengraben", true)); // edit on the last typed letter
        assert!(w("zurihc", "zurich", false));
    }

    #[test]
    fn house_numbers() {
        assert!(is_house_number("3"));
        assert!(is_house_number("3a"));
        assert!(is_house_number("12bis"));
        assert!(is_house_number("8001"));
        assert!(!is_house_number("a3"));
        assert!(!is_house_number("80010"));
        assert_eq!(leading_int("12a"), 12);
        assert_eq!(leading_int("a"), u32::MAX);
    }
}
