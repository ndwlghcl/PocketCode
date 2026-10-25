"""TLS 证书：为安装实例生成并复用自签证书（架构文档 §3.1）。

设计要点：
- 首次启动生成 EC P-256 自签证书，之后一直复用（同一实例身份稳定，
  二维码里的证书指纹才有意义）；
- 指纹 = 证书 DER 的 SHA-256（`sha256:<64hex>`），手机配对时校验的对象；
- 证书文件保存在设置目录旁的 tls/ 子目录，不入仓库。
"""

from __future__ import annotations

import ipaddress
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

logger = logging.getLogger("pocketcode.security.tls")

CERT_FILE_NAME = "server-cert.pem"
KEY_FILE_NAME = "server-key.pem"
VALIDITY_DAYS = 3650


class TlsError(Exception):
    """证书生成/加载失败。"""


@dataclass(frozen=True)
class ServerTls:
    cert_path: Path
    key_path: Path
    """证书指纹：`sha256:<64 位小写十六进制>`（DER 编码的 SHA-256）。"""
    fingerprint: str


def ensure_server_tls(directory: Path) -> ServerTls:
    """返回可用证书；目录里已有可解析证书则复用，否则生成新的。"""
    directory.mkdir(parents=True, exist_ok=True)
    cert_path = directory / CERT_FILE_NAME
    key_path = directory / KEY_FILE_NAME

    if cert_path.exists() and key_path.exists():
        try:
            fingerprint = _load_fingerprint(cert_path)
            return ServerTls(cert_path=cert_path, key_path=key_path, fingerprint=fingerprint)
        except Exception:  # noqa: BLE001 - 文件损坏时重新生成
            logger.warning("existing TLS material unreadable, regenerating", exc_info=True)

    return _generate(cert_path, key_path)


def _load_fingerprint(cert_path: Path) -> str:
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    return "sha256:" + cert.fingerprint(hashes.SHA256()).hex()


def _generate(cert_path: Path, key_path: Path) -> ServerTls:
    try:
        key = ec.generate_private_key(ec.SECP256R1())
        subject = issuer = x509.Name(
            [x509.NameAttribute(NameOID.COMMON_NAME, "PocketCode Server")]
        )
        now = datetime.now(tz=timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))  # 容忍设备时钟略慢
            .not_valid_after(now + timedelta(days=VALIDITY_DAYS))
            .add_extension(
                x509.SubjectAlternativeName(
                    [
                        x509.DNSName("localhost"),
                        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                    ]
                ),
                critical=False,
            )
            .add_extension(
                x509.BasicConstraints(ca=True, path_length=None),
                critical=True,  # 自签证书要当信任锚，必须是 CA
            )
            .sign(key, hashes.SHA256())
        )
        key_pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key_pem)
    except OSError as exc:
        raise TlsError(f"无法写入 TLS 证书文件：{exc}") from exc

    fingerprint = "sha256:" + cert.fingerprint(hashes.SHA256()).hex()
    logger.info("generated self-signed TLS certificate, fingerprint=%s", fingerprint)
    return ServerTls(cert_path=cert_path, key_path=key_path, fingerprint=fingerprint)
