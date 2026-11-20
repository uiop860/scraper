# Scraper Privacy Policy

Last updated: November 20, 2026

Scraper is a Firefox extension maintained by Oliver Staehr. Its AI agent uses
OpenAI's Sign in with ChatGPT flow and OpenAI services. This policy describes
information the extension handles when you use it.

## Information Scraper handles

When you sign in, Scraper receives account information from OpenAI, including a
stable account identifier and, when provided, your email address. It receives
OAuth credentials needed to maintain your sign-in and use the access you
authorize. Your PIN is used locally to encrypt your saved refresh credential;
Scraper does not store the PIN itself.

When you ask the AI agent to build or test a scraper, it sends relevant page
information to OpenAI. This can include the page URL and origin, selected page
content or DOM samples, your instructions, and sample rows or diagnostics from
scraper tests. The agent uses this information to inspect the page and generate,
test, or revise scraping rules. You choose which pages to grant access to and
when to run the agent. Do not submit information you are not authorized to
share with OpenAI.

Scraper also stores your selected OpenAI model and a random installation
identifier in Firefox storage. Scraper configuration and scraping results are
held in the extension page while it is open. Results are not sent to the
developer; you choose whether to download or otherwise share them.

## Where information is stored and sent

Authentication requests and AI requests go directly from the extension to
OpenAI's services, including `auth.openai.com` and `api.openai.com`. The
extension developer does not operate a server that receives your account data,
page content, prompts, or scraping results. The extension does not include
advertising or analytics code.

Your refresh credential is encrypted in the extension's local IndexedDB using a
key derived from your PIN. A short-lived access token and session key material
may be held in Firefox session storage while Firefox is running. The account
identifier and email are included in that encrypted credential record. The PIN
is not persisted. Page content and agent conversation state are kept in memory
for the active extension page and are not saved as scraper history by the
extension.

OpenAI processes information sent to its services under its own terms and
privacy policy. Scraper requests Responses API output with storage disabled
(`store: false`), but this setting does not replace OpenAI's policies or
determine all of OpenAI's processing and retention practices. Review
[OpenAI's Privacy Policy](https://openai.com/policies/privacy-policy/) and
[Terms of Use](https://openai.com/policies/terms-of-use/) for details.

## Your choices and deleting information

You control which pages receive access and when to start an AI agent run. You
can sign out in Scraper's account settings. Signing out deletes Scraper's local
authentication data and attempts to revoke the renewable OpenAI session. If
remote revocation cannot be confirmed, disconnect Scraper from your ChatGPT
account settings. You can remove the extension from Firefox to remove its
remaining local extension data. OpenAI's handling of information already sent
to it is governed by OpenAI's policies and account controls.

## Contact

For privacy questions about Scraper, contact
[spammig96@gmail.com](mailto:spammig96@gmail.com).
