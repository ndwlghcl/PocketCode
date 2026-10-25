"""TLS 自签证书：生成、复用、指纹一致性。"""

from __future__ import annotations

import hashlib
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization

from pocketcode.security.tls import ensure_server_tls


def _expected_fingerprint(cert_path: Path) -> str:
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    return "sha256:" + cert.fingerprint(hashes.SHA256()).hex()


def test_generates_cert_and_key(tmp_path):
    tls = ensure_server_tls(tmp_path)
    assert tls.cert_path.exists() and tls.key_path.exists()
    assert tls.fingerprint.startswith("sha256:")
    assert len(tls.fingerprint) == len("sha256:") + 64
    assert tls.fingerprint == _expected_fingerprint(tls.cert_path)


def test_reuses_existing_material(tmp_path):
    first = ensure_server_tls(tmp_path)
    second = ensure_server_tls(tmp_path)
    assert first.fingerprint == second.fingerprint
    assert first.cert_path == second.cert_path
    # 同一实例身份必须稳定（二维码指纹才可信）
    assert first.cert_path.read_bytes() == second.cert_path.read_bytes()


def test_regenerates_corrupt_material(tmp_path):
    ensure_server_tls(tmp_path)
    (tmp_path / "server-cert.pem").write_bytes(b"not a certificate")
    regenerated = ensure_server_tls(tmp_path)
    assert regenerated.fingerprint == _expected_fingerprint(regenerated.cert_path)
    assert regenerated.cert_path.read_bytes() != b"not a certificate"


def test_fingerprint_matches_manual_sha256(tmp_path):
    tls = ensure_server_tls(tmp_path)
    cert = x509.load_pem_x509_certificate(tls.cert_path.read_bytes())
    der = cert.public_bytes(serialization.Encoding.DER)
    assert tls.fingerprint == "sha256:" + hashlib.sha256(der).hexdigest()
