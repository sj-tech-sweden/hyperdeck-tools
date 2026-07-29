# SharePoint / OneDrive Setup Guide

This guide walks through setting up the SharePoint/OneDrive storage plugin to automatically upload HyperDeck recordings to Microsoft cloud storage.

## Overview

The plugin supports two modes:

| Mode | Use Case | Auth Method | User Interaction |
|------|----------|-------------|------------------|
| **OneDrive** | Personal or shared OneDrive folders | Refresh token | One-time browser login |
| **SharePoint App** | SharePoint document libraries | Client secret | None (app-only) |

---

## Prerequisites

- Access to [Azure Portal](https://portal.azure.com)
- Ability to register applications (may need admin consent)
- A Microsoft 365 account with OneDrive or SharePoint access

---

## Option 1: OneDrive Setup

Best for: uploading to a personal or shared OneDrive folder.

### Step 1: Register an Azure AD App

1. Go to [Azure Portal > App registrations](https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps)
2. Click **New registration**
3. Fill in:
   - **Name**: `HyperDeck Upload` (or any name you prefer)
   - **Supported account types**: Choose based on your organization
   - **Redirect URI**: Select **Mobile and desktop applications** and enter `http://localhost`
4. Click **Register**
5. Note down the **Application (client) ID** and **Directory (tenant) ID**

### Step 2: Configure API Permissions

1. In your app, go to **API permissions** > **Add a permission**
2. Select **Microsoft Graph** > **Delegated permissions**
3. Add these permissions:
   - `Files.ReadWrite.All` — Read and write all files in your OneDrive
   - `offline_access` — Maintain access after you sign in (required for refresh tokens)
4. Click **Grant admin consent** if prompted

### Step 3: Create a Client Secret

1. Go to **Certificates & secrets** > **New client secret**
2. Add a description and expiry (e.g. 24 months)
3. Click **Add**
4. **Copy the secret value immediately** — it won't be shown again

### Step 4: Get a Refresh Token

You need to complete a one-time OAuth2 flow to get a refresh token. Use one of these methods:

#### Method A: Using PowerShell (Windows)

```powershell
$clientId = "YOUR_CLIENT_ID"
$tenantId = "YOUR_TENANT_ID"
$redirectUri = "http://localhost"
$scope = "offline_access Files.ReadWrite.All"

# Build the authorization URL
$authUrl = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/authorize?" +
    "client_id=$clientId&response_type=code&redirect_uri=$redirectUri" +
    "&scope=$scope&response_mode=query"

Write-Host "Open this URL in your browser:"
Write-Host $authUrl

# After authorizing, you'll be redirected to a URL like:
# http://localhost?code=AUTH_CODE_HERE&session_state=...
# Copy the 'code' parameter value

$code = "PASTE_AUTH_CODE_HERE"
$body = @{
    client_id = $clientId
    grant_type = "authorization_code"
    code = $code
    redirect_uri = $redirectUri
    scope = "offline_access Files.ReadWrite.All"
}

$response = Invoke-RestMethod -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token" -Method Post -Body $body
Write-Host "Refresh Token:" $response.refresh_token
```

#### Method B: Using Python

```python
import requests

CLIENT_ID = "YOUR_CLIENT_ID"
TENANT_ID = "YOUR_TENANT_ID"
REDIRECT_URI = "http://localhost"
SCOPE = "offline_access Files.ReadWrite.All"

# Step 1: Open this URL in your browser
auth_url = (
    f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/authorize"
    f"?client_id={CLIENT_ID}"
    f"&response_type=code"
    f"&redirect_uri={REDIRECT_URI}"
    f"&scope={SCOPE}"
    f"&response_mode=query"
)
print(f"Open this URL in your browser:\n{auth_url}\n")

# Step 2: After authorizing, paste the full redirect URL
redirect_url = input("Paste the redirect URL here: ")
code = redirect_url.split("code=")[1].split("&")[0]

# Step 3: Exchange code for tokens
token_response = requests.post(
    f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
    data={
        "client_id": CLIENT_ID,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPE,
    },
)
tokens = token_response.json()
print(f"Refresh Token: {tokens['refresh_token']}")
```

### Step 5: Configure the Plugin

In the HyperDeck web UI, go to **Storage Plugin Destinations** > **+ Add** and select **SharePoint / OneDrive**:

| Field | Value |
|-------|-------|
| Tenant ID | Your Directory (tenant) ID |
| Client ID | Your Application (client) ID |
| Client Secret | The secret value you copied |
| Auth Mode | `onedrive` |
| Refresh Token | The refresh token from Step 4 |
| Drive Path | `/HyperDeck` (or your preferred folder) |

Click **Test Connection** to verify, then **Save**.

---

## Option 2: SharePoint App-Only Setup

Best for: uploading to a SharePoint document library without user interaction.

### Step 1: Register an Azure AD App

1. Go to [Azure Portal > App registrations](https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps)
2. Click **New registration**
3. Fill in:
   - **Name**: `HyperDeck SharePoint Upload`
   - **Supported account types**: Choose based on your organization
   - **Redirect URI**: Leave blank (not needed for app-only)
4. Click **Register**
5. Note down the **Application (client) ID** and **Directory (tenant) ID**

### Step 2: Configure API Permissions

1. In your app, go to **API permissions** > **Add a permission**
2. Select **Microsoft Graph** > **Application permissions**
3. Add this permission:
   - `Sites.ReadWrite.All` — Read and write items in all site collections
4. Click **Grant admin consent** (this requires admin privileges)

### Step 3: Create a Client Secret

1. Go to **Certificates & secrets** > **New client secret**
2. Add a description and expiry
3. Click **Add**
4. **Copy the secret value immediately**

### Step 4: Find Your SharePoint Site URL

Your site URL looks like one of these:
- `https://contoso.sharepoint.com/sites/ingest`
- `https://contoso.sharepoint.com`

You can find it by going to your SharePoint site in a browser and copying the URL.

### Step 5: Configure the Plugin

In the HyperDeck web UI, go to **Storage Plugin Destinations** > **+ Add** and select **SharePoint / OneDrive**:

| Field | Value |
|-------|-------|
| Tenant ID | Your Directory (tenant) ID |
| Client ID | Your Application (client) ID |
| Client Secret | The secret value you copied |
| Auth Mode | `sharepoint_app` |
| Site URL | `https://contoso.sharepoint.com/sites/ingest` |
| Drive Path | `/HyperDeck` (or your preferred folder) |

Click **Test Connection** to verify, then **Save**.

---

## Troubleshooting

### "Authentication failed (401)"

- **OneDrive**: Make sure you're using the refresh token from the OAuth2 flow, not a password
- **SharePoint**: Verify the client secret hasn't expired
- Both: Check that API permissions were granted admin consent

### "Access denied (403)"

- **OneDrive**: The `Files.ReadWrite.All` permission may need admin consent
- **SharePoint**: The `Sites.ReadWrite.All` application permission requires admin consent
- Check that the user/account has write access to the target drive

### "Failed to acquire token"

- Verify the **Tenant ID** is correct (not the display name)
- Verify the **Client ID** matches the app registration
- For OneDrive: ensure `offline_access` permission was added
- For SharePoint: ensure the app has a client secret (not just a certificate)

### "Site not found" (SharePoint)

- Verify the **Site URL** is exactly as shown in your browser
- Include the full path: `https://contoso.sharepoint.com/sites/mysite`
- Try accessing the URL in a browser first to confirm it exists

### Token Expired

- Refresh tokens can expire after 90 days of inactivity
- Re-run the OAuth2 flow to get a new refresh token
- Update the plugin config with the new token

---

## Permission Summary

| Mode | Required Permissions | Type |
|------|---------------------|------|
| OneDrive | `Files.ReadWrite.All`, `offline_access` | Delegated |
| SharePoint | `Sites.ReadWrite.All` | Application |
