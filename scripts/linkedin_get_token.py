"""Authorize the LinkedIn posting bot once using 3-legged OAuth.

Run from the repository directory:
    python3 scripts/linkedin_get_token.py

Reads CLIENT_ID/CLIENT_SECRET directly from the private project .env; does not
execute the file in the shell. After consent, paste the full redirected URL
INCLUDING ?code=...&state=... into the terminal. Saves the token and member
URN back to .env securely, leaving publishing disabled for review.
"""

import os
import re
import secrets
import sys
import tempfile
import urllib.parse
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
DEFAULT_REDIRECT = "http://localhost:8080/callback"
SCOPES = "w_member_social openid profile email"


def read_env() -> dict[str, str]:
    values = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if not re.match(r"^\s*[A-Z][A-Z0-9_]*\s*=", line):
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            values[key.strip()] = value
    return values


def save_env_values(updates: dict[str, str]) -> None:
    """Atomically replace only selected keys; protect OAuth credentials on disk."""
    for value in updates.values():
        if "\n" in value or "\r" in value:
            raise ValueError("Unexpected newline in credential")
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []
    remaining = dict(updates)
    output = []
    for line in lines:
        match = re.match(r"^(\s*)([A-Z][A-Z0-9_]*)(\s*=).*$", line)
        if match and match.group(2) in remaining:
            key = match.group(2)
            output.append(f"{key}={remaining.pop(key)}")
        else:
            output.append(line)
    output.extend(f"{key}={value}" for key, value in remaining.items())
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".env.linkedin-", dir=ENV_FILE.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write("\n".join(output) + "\n")
        os.replace(tmp, ENV_FILE)
        os.chmod(ENV_FILE, 0o600)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main() -> None:
    values = read_env()
    client_id = os.environ.get("LINKEDIN_CLIENT_ID") or values.get("LINKEDIN_CLIENT_ID")
    client_secret = os.environ.get("LINKEDIN_CLIENT_SECRET") or values.get("LINKEDIN_CLIENT_SECRET")
    redirect_uri = os.environ.get("LINKEDIN_REDIRECT_URI") or values.get("LINKEDIN_REDIRECT_URI") or DEFAULT_REDIRECT

    if not client_id or not client_secret:
        sys.exit("Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in your private .env first.")

    state = secrets.token_urlsafe(24)
    params = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": SCOPES,
        "state": state,
    })
    print("\nStep 1: In LinkedIn Developer Portal > Auth, add this exact redirect URL:")
    print(redirect_uri)
    print("\nStep 2: Open the following authorization link in a browser on your computer.")
    print("Sign in and click Allow. The redirect may show 'connection refused' because")
    print("no server is running locally; that is normal for this CLI flow.")
    print("\nhttps://www.linkedin.com/oauth/v2/authorization?" + params)
    print("\nStep 3: Copy the ENTIRE final browser address, including")
    print("'?code=...&state=...', and paste it below.")
    print("Do NOT paste only " + redirect_uri + ".")
    print("Do not share the redirect URL or authorization code in chat.\n")

    redirected = input("Paste full redirected URL here: ").strip()
    parsed = urllib.parse.urlparse(redirected)
    expected = urllib.parse.urlparse(redirect_uri)
    if (parsed.scheme, parsed.netloc, parsed.path) != (expected.scheme, expected.netloc, expected.path):
        sys.exit("The pasted URL does not match the configured redirect URL. Restart the script.")
    query = urllib.parse.parse_qs(parsed.query)
    if query.get("error"):
        message = query.get("error_description", query["error"])[0]
        sys.exit("LinkedIn authorization refused: " + message[:250])
    code = query.get("code", [None])[0]
    returned_state = query.get("state", [None])[0]
    if not code:
        sys.exit("No authorization code in callback. Open the generated LinkedIn link, click Allow, and copy the final URL including ?code=...&state=....")
    if not returned_state or not secrets.compare_digest(returned_state, state):
        sys.exit("OAuth state mismatch. Restart the script and authorize again.")

    try:
        response = requests.post(
            "https://www.linkedin.com/oauth/v2/accessToken",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": client_id,
                "client_secret": client_secret,
            },
            timeout=30,
        )
        if not response.ok:
            sys.exit(f"LinkedIn token exchange failed (HTTP {response.status_code}). Check app products, redirect URL and secret; restart OAuth with a fresh code.")
        token_data = response.json()
        token = token_data.get("access_token")
        if not isinstance(token, str) or not token:
            sys.exit("LinkedIn returned no access token. Verify the requested OAuth scopes.")
        profile_response = requests.get(
            "https://api.linkedin.com/v2/userinfo",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if not profile_response.ok:
            sys.exit(f"LinkedIn userinfo request failed (HTTP {profile_response.status_code}). Verify the OpenID Connect product and scopes.")
        subject = profile_response.json().get("sub")
        if not isinstance(subject, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", subject):
            sys.exit("LinkedIn userinfo did not provide a valid member identifier (sub).")
    except requests.RequestException as exc:
        sys.exit(f"LinkedIn network error ({type(exc).__name__}). Check your connection and retry OAuth.")

    save_env_values({
        "LINKEDIN_ACCESS_TOKEN": token,
        "LINKEDIN_PERSON_URN": "urn:li:person:" + subject,
        "LINKEDIN_PUBLISH_ENABLED": "false",
    })
    print("\nSuccess: LinkedIn access token and member URN saved privately in .env.")
    print("Publishing was set to false for safety. No post was created.")
    print("Token lifetime (seconds):", token_data.get("expires_in", "not provided"))
    print("Review your current draft before setting LINKEDIN_PUBLISH_ENABLED=true.")
    print("Restart the bot after changing .env.")


if __name__ == "__main__":
    main()
