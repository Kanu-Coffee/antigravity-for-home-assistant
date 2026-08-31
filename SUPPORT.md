# Support and diagnostic reports

For an Antigravity for Home Assistant problem:

1. From a Remote task or the App Ingress terminal, run `/ha-feedback bug` to
   investigate in read-only mode and prepare a sanitized report.
2. Review every generated file. Remove personal Home Assistant data and confirm
   that it contains no OAuth material, tokens, private keys, `secrets.yaml`, or
   `.storage` content.
3. Search existing [GitHub Issues](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/issues).
4. Open an issue with the App version, architecture, Home Assistant/HAOS
   versions, exact reproduction steps, expected and actual behavior, and the
   public-safe evidence.

Do not describe source, container, or emulated results as real HAOS evidence.
Use `NOT RUN` for unperformed checks and `PARTIAL` for incomplete coverage.

For a vulnerability, authentication bypass, or possible credential exposure,
stop public search and submission. Follow the private process in
[the security policy](.github/SECURITY.md).
