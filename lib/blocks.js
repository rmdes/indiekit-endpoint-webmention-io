/**
 * Webmention-io v2 block declaration (Phase 7b — plugin block ownership).
 *
 * The `webmentions` sidebar widget was a site-config BUILTIN_BLOCKS seed
 * (requiresPlugin null, gated only by the theme's legacy widgetPluginRequirements
 * render-map). Declaring it here makes site-config's scanPlugins stamp
 * `sourcePlugin` → `requiresPlugin` ("Webmention moderation endpoint"), so the
 * block is properly plugin-gated (theme ENDPOINT_SLUGS maps it to the
 * `webmention-io` loadout slug). scanPlugins precedence is `built-in < plugin
 * blocks`, so this entry OVERWRITES the builtin seed on sites where the plugin is
 * loaded; the seed itself is removed from site-config in Phase 7d alongside the
 * legacy-map bridge.
 *
 * Descriptor is byte-faithful to the BUILTIN_BLOCKS entry. Bespoke template: the
 * theme owns `components/widgets/webmentions.njk` (no generic `render.renderer`);
 * `data.source:"api"` documents the runtime fetch.
 *
 * @module lib/blocks
 */

/** @type {Array<object>} */
export const WEBMENTION_BLOCKS = [
  {
    id: "webmentions",
    version: 1,
    label: "Webmentions",
    description: "Recent inbound/outbound webmentions",
    icon: "message-circle",
    category: "social",
    placement: { regions: ["sidebar"], surfaces: ["homepage", "postType"] },
    multiple: false,
    data: { source: "api" },
    schema: { type: "object", additionalProperties: false, properties: {} },
  },
];
