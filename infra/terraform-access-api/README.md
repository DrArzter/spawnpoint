# Access API and browser identity

This isolated root owns Cognito, the JWT-protected HTTP API and its Lambda. It reads the access table but cannot affect game compute.

The SPA uses Cognito Authorization Code with PKCE. Google is optional during the first apply because Google requires Cognito's redirect URI before it can issue client credentials.

1. Copy `terraform.tfvars.example` to ignored `terraform.tfvars` and set the explicitly chosen bootstrap owner email.
2. Apply once to obtain `google_redirect_uri`.
3. Create a Google OAuth 2.0 **Web application** with that redirect URI.
4. Add its client id and secret to the ignored tfvars and apply again.
5. Wire the non-secret API URL, Cognito domain, pool id and client id into the web build.

An arbitrary Google account can authenticate to Cognito, but `/me` returns no identity unless it is the exact verified bootstrap email or has already been linked by an Owner.
