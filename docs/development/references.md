# Current references

Use primary upstream documentation for behavior that can change. Record the
upstream version or retrieval date in implementation evidence when it matters.

## Google Antigravity

- [Remote Control](https://antigravity.google/docs/remote-control/)
- [Antigravity CLI documentation](https://antigravity.google/docs/cli/)
- [CLI permissions](https://antigravity.google/docs/cli/permissions/)
- [Remote Control Dashboard](https://antigravity.google.com/)
- [Remote Control launch article](https://antigravity.google/blog/remote-control-for-antigravity)

The image pins Antigravity CLI rather than installing the current network
version at runtime. Revalidate flags, authentication behavior, supported
architectures, and checksums whenever the pin changes.

## Home Assistant

- [App configuration](https://developers.home-assistant.io/docs/add-ons/configuration/)
- [App security](https://developers.home-assistant.io/docs/add-ons/security/)
- [Ingress](https://developers.home-assistant.io/docs/add-ons/presentation/)
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)

Repository source, test fixtures, and upstream documentation do not establish
real HAOS behavior. Store only sanitized evidence and never copy live
authorization material into development notes.
