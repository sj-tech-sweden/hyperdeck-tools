"""Amazon S3 / S3-compatible storage plugin.

Uploads files to S3-compatible object storage (AWS S3, MinIO, DigitalOcean Spaces, etc.).
Requires the 'boto3' package to be installed.
"""

import os

PLUGIN_LABEL = "Amazon S3"
PLUGIN_DESCRIPTION = "Upload files to an S3-compatible bucket (AWS S3, MinIO, etc.)"
PLUGIN_STORAGE_TYPE = "s3"
PLUGIN_CONFIG_FIELDS = [
    {"key": "bucket", "label": "Bucket Name", "type": "text", "required": True, "default": ""},
    {"key": "region", "label": "Region", "type": "text", "required": False, "default": "us-east-1"},
    {"key": "prefix", "label": "Key Prefix (optional)", "type": "text", "required": False, "default": ""},
    {"key": "endpoint_url", "label": "Endpoint URL (optional, for S3-compatible)", "type": "text", "required": False, "default": ""},
    {"key": "access_key", "label": "Access Key ID", "type": "text", "required": True, "default": ""},
    {"key": "secret_key", "label": "Secret Access Key", "type": "password", "required": True, "default": ""},
]


def _get_s3_client(config: dict):
    """Create and return an S3 client."""
    try:
        import boto3
    except ImportError:
        raise ImportError("boto3 is required for S3 storage. Install with: pip install boto3")

    kwargs = {
        "aws_access_key_id": config.get("access_key", ""),
        "aws_secret_access_key": config.get("secret_key", ""),
        "region_name": config.get("region", "us-east-1"),
    }
    endpoint_url = config.get("endpoint_url", "").strip()
    if endpoint_url:
        kwargs["endpoint_url"] = endpoint_url

    return boto3.client("s3", **kwargs)


def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    """Upload a file to the configured S3 bucket."""
    if not os.path.exists(local_path):
        return False

    bucket = config.get("bucket", "")
    if not bucket:
        return False

    prefix = config.get("prefix", "").strip().strip("/")
    key = f"{prefix}/{remote_name}" if prefix else remote_name

    try:
        client = _get_s3_client(config)
        client.upload_file(local_path, bucket, key)
        return True
    except Exception:
        return False


def test_connection(config: dict) -> dict:
    """Test S3 connectivity by listing the bucket."""
    bucket = config.get("bucket", "")
    if not bucket:
        return {"ok": False, "message": "No bucket configured."}

    try:
        client = _get_s3_client(config)
        client.head_bucket(Bucket=bucket)
        return {"ok": True, "message": f"Connected to bucket: {bucket}"}
    except ImportError as e:
        return {"ok": False, "message": str(e)}
    except Exception as e:
        error_msg = str(e)
        if "403" in error_msg or "AccessDenied" in error_msg:
            return {"ok": False, "message": f"Access denied to bucket: {bucket}"}
        if "NoSuchBucket" in error_msg or "301" in error_msg:
            return {"ok": False, "message": f"Bucket not found: {bucket}"}
        return {"ok": False, "message": error_msg}
