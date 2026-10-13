// SPDX-License-Identifier: AGPL-3.0-only
//! Cryptography for the sealoffice vault: age (X25519 and scrypt passphrase
//! files) and Office Agile encryption, exported to JavaScript.
//!
//! Secrets stay inside this module: the vault key is an opaque [`Identity`]
//! and every copy of a key string or passphrase held here is zeroized.

use std::io::{Read, Write};
use std::iter;
use std::str::FromStr;

use age::armor::ArmoredReader;
use age::secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

const AGE_MAGIC: &[u8] = b"age-encryption.org/v1";
const ARMOR_BEGIN: &[u8] = b"-----BEGIN AGE ENCRYPTED FILE-----";

/// An error with a short English message; thrown to JavaScript as `Error`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl Error {
    fn new(message: impl Into<String>) -> Self {
        Error(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<Error> for JsValue {
    fn from(e: Error) -> Self {
        JsError::new(&e.0).into()
    }
}

type Result<T> = std::result::Result<T, Error>;

/// The vault key: an age X25519 identity whose secret never leaves wasm.
#[wasm_bindgen]
pub struct Identity {
    inner: age::x25519::Identity,
}

#[wasm_bindgen]
impl Identity {
    /// A fresh random identity.
    pub fn generate() -> Identity {
        Identity { inner: age::x25519::Identity::generate() }
    }

    /// Opens a key wrapped by [`Identity::wrap`]; fails on a wrong passphrase.
    pub fn unlock(wrapped: &[u8], passphrase: &str) -> Result<Identity> {
        let plain = Zeroizing::new(decrypt_passphrase(wrapped, passphrase)?);
        let key = std::str::from_utf8(&plain).map_err(|_| Error::new("not a vault key"))?;
        Identity::from_secret_key(key.trim())
    }

    /// Parses an `AGE-SECRET-KEY-1…` string.
    pub fn from_secret_key(key: &str) -> Result<Identity> {
        age::x25519::Identity::from_str(key.trim())
            .map(|inner| Identity { inner })
            .map_err(|_| Error::new("not an age secret key"))
    }

    /// The public `age1…` recipient.
    pub fn recipient(&self) -> String {
        self.inner.to_public().to_string()
    }

    /// The secret key as an age passphrase-encrypted file.
    pub fn wrap(&self, passphrase: &str) -> Result<Vec<u8>> {
        let key = self.inner.to_string();
        encrypt_passphrase(key.expose_secret().as_bytes(), passphrase)
    }

    /// Encrypts `plain` to this identity's own recipient.
    pub fn encrypt(&self, plain: &[u8]) -> Result<Vec<u8>> {
        encrypt_with(&self.inner.to_public(), plain)
    }

    pub fn decrypt(&self, ct: &[u8]) -> Result<Vec<u8>> {
        decrypt_with(&self.inner, ct, "this file is not encrypted to the vault key")
    }
}

/// Encrypts `plain` to an `age1…` recipient.
#[wasm_bindgen]
pub fn encrypt_to(recipient: &str, plain: &[u8]) -> Result<Vec<u8>> {
    let recipient = age::x25519::Recipient::from_str(recipient.trim())
        .map_err(|_| Error::new("not an age recipient"))?;
    encrypt_with(&recipient, plain)
}

#[wasm_bindgen]
pub fn encrypt_passphrase(plain: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    if passphrase.is_empty() {
        return Err(Error::new("empty passphrase"));
    }
    let recipient = age::scrypt::Recipient::new(secret(passphrase));
    encrypt_with(&recipient, plain)
}

#[wasm_bindgen]
pub fn decrypt_passphrase(ct: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    let identity = age::scrypt::Identity::new(secret(passphrase));
    decrypt_with(&identity, ct, "wrong passphrase")
}

/// Whether `bytes` is an age file, binary or ASCII-armored.
#[wasm_bindgen]
pub fn is_age(bytes: &[u8]) -> bool {
    bytes.starts_with(AGE_MAGIC) || trim_start(bytes).starts_with(ARMOR_BEGIN)
}

#[wasm_bindgen]
pub fn office_is_encrypted(bytes: &[u8]) -> bool {
    ibis_ooxml::encryption::is_encrypted(bytes)
}

#[wasm_bindgen]
pub fn office_decrypt(bytes: &[u8], password: &str) -> Result<Vec<u8>> {
    use ibis_ooxml::encryption::DecryptError;
    ibis_ooxml::encryption::decrypt(bytes, password).map_err(|e| match e {
        DecryptError::WrongPassword => Error::new("wrong password"),
        DecryptError::Unsupported(_) => Error::new("unsupported Office encryption"),
        DecryptError::Damaged(_) => Error::new("damaged encrypted Office file"),
    })
}

/// Protects an Office package with a password (Agile encryption).
#[wasm_bindgen]
pub fn office_protect(package: &[u8], password: &str) -> Result<Vec<u8>> {
    if password.is_empty() {
        return Err(Error::new("empty password"));
    }
    let mut failed = false;
    let mut random = |buf: &mut [u8]| failed |= getrandom::getrandom(buf).is_err();
    let out = ibis_ooxml::encryption::encrypt(package, password, &mut random);
    if failed {
        return Err(Error::new("no secure random source"));
    }
    Ok(out)
}

#[wasm_bindgen]
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn secret(s: &str) -> SecretString {
    SecretString::from(s.to_owned())
}

fn trim_start(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    &bytes[start..]
}

fn encrypt_with(recipient: &dyn age::Recipient, plain: &[u8]) -> Result<Vec<u8>> {
    let failed = |_| Error::new("encryption failed");
    let encryptor = age::Encryptor::with_recipients(iter::once(recipient)).map_err(|_| Error::new("encryption failed"))?;
    let mut out = Vec::with_capacity(plain.len() + 256);
    let mut writer = encryptor.wrap_output(&mut out).map_err(failed)?;
    writer.write_all(plain).map_err(failed)?;
    writer.finish().map_err(failed)?;
    Ok(out)
}

fn decrypt_with(identity: &dyn age::Identity, ct: &[u8], no_match: &str) -> Result<Vec<u8>> {
    if !is_age(ct) {
        return Err(Error::new("not an age file"));
    }
    let decryptor = age::Decryptor::new(ArmoredReader::new(ct)).map_err(|_| Error::new("damaged age file"))?;
    let mut reader = decryptor.decrypt(iter::once(identity)).map_err(|e| match e {
        age::DecryptError::DecryptionFailed | age::DecryptError::NoMatchingKeys => Error::new(no_match),
        age::DecryptError::ExcessiveWork { .. } => Error::new("passphrase work factor too high"),
        _ => Error::new("damaged age file"),
    })?;
    let mut plain = Vec::with_capacity(ct.len());
    if reader.read_to_end(&mut plain).is_err() {
        plain.zeroize();
        return Err(Error::new("damaged age file"));
    }
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_zip() -> Vec<u8> {
        use ibis_ooxml::zip::{EntryMeta, Writer};
        let mut w = Writer::new();
        w.add("[Content_Types].xml", EntryMeta::default(), b"<Types/>").unwrap();
        w.add("word/document.xml", EntryMeta::default(), b"<w:document>hello</w:document>").unwrap();
        w.finish().unwrap()
    }

    #[test]
    fn x25519_round_trip() {
        let id = Identity::generate();
        assert!(id.recipient().starts_with("age1"));
        let ct = encrypt_to(&id.recipient(), b"secret text").unwrap();
        assert!(ct.starts_with(AGE_MAGIC));
        assert_eq!(id.decrypt(&ct).unwrap(), b"secret text");
        assert_eq!(id.decrypt(&id.encrypt(b"again").unwrap()).unwrap(), b"again");
        let other = Identity::generate();
        assert!(other.decrypt(&ct).is_err());
    }

    #[test]
    fn wrap_unlock_round_trip() {
        let id = Identity::generate();
        let wrapped = id.wrap("correct horse").unwrap();
        let back = Identity::unlock(&wrapped, "correct horse").unwrap();
        assert_eq!(back.recipient(), id.recipient());
        let err = Identity::unlock(&wrapped, "wrong horse").err().unwrap();
        assert_eq!(err.message(), "wrong passphrase");
    }

    #[test]
    fn secret_key_import() {
        let id = Identity::generate();
        let key = id.inner.to_string();
        let back = Identity::from_secret_key(key.expose_secret()).unwrap();
        assert_eq!(back.recipient(), id.recipient());
        assert!(Identity::from_secret_key("AGE-SECRET-KEY-1NOPE").is_err());
    }

    #[test]
    fn passphrase_round_trip() {
        let ct = encrypt_passphrase(b"plain bytes", "pw").unwrap();
        assert!(is_age(&ct));
        assert_eq!(decrypt_passphrase(&ct, "pw").unwrap(), b"plain bytes");
        assert_eq!(decrypt_passphrase(&ct, "nope").unwrap_err().message(), "wrong passphrase");
        assert!(encrypt_passphrase(b"x", "").is_err());
    }

    #[test]
    fn armored_decrypt() {
        let id = Identity::generate();
        let encryptor = age::Encryptor::with_recipients(iter::once(&id.inner.to_public() as &dyn age::Recipient)).unwrap();
        let mut armored = vec![];
        let output = age::armor::ArmoredWriter::wrap_output(&mut armored, age::armor::Format::AsciiArmor).unwrap();
        let mut writer = encryptor.wrap_output(output).unwrap();
        writer.write_all(b"armored").unwrap();
        writer.finish().unwrap().finish().unwrap();
        assert!(armored.starts_with(ARMOR_BEGIN));
        assert!(is_age(&armored));
        assert_eq!(id.decrypt(&armored).unwrap(), b"armored");
    }

    #[test]
    fn tamper_is_detected() {
        let id = Identity::generate();
        let mut ct = id.encrypt(&[7u8; 1000]).unwrap();
        let last = ct.len() - 10;
        ct[last] ^= 1;
        assert!(id.decrypt(&ct).is_err());
        assert_eq!(id.decrypt(b"PK\x03\x04").unwrap_err().message(), "not an age file");
    }

    #[test]
    fn office_round_trip() {
        let zip = tiny_zip();
        assert!(!office_is_encrypted(&zip));
        let protected = office_protect(&zip, "office pw").unwrap();
        assert!(office_is_encrypted(&protected));
        assert_eq!(office_decrypt(&protected, "office pw").unwrap(), zip);
        assert_eq!(office_decrypt(&protected, "other").unwrap_err().message(), "wrong password");
    }

    #[test]
    fn sha256() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
