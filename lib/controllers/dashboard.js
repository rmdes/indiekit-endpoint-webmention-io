/**
 * Dashboard controller
 * Admin UI for webmention moderation
 */

import {
  getWebmentions,
  getWebmentionCounts,
  hideWebmention,
  unhideWebmention,
  hideByDomain,
  deleteByDomain,
} from "../storage/webmentions.js";
import { blockDomain } from "../storage/blocklist.js";
import { getSyncState } from "../sync.js";
import { getMentionType, getMentionTitle, getAuthorName } from "../utils.js";

/**
 * Format a date for direct display in templates (NOT through macros).
 * Returns a human-readable string or null.
 * @param {*} value
 * @returns {string|null}
 */
function formatDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Convert any date value to an ISO 8601 string safe for the Nunjucks | date
 * filter (which calls date-fns parseISO — crashes on Date objects, null, and
 * undefined). Use this for values that pass through mention()/card() macros.
 * @param {*} value
 * @returns {string|null}
 */
function toISO(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export const dashboardController = {
  /**
   * GET / - Webmentions dashboard
   */
  async list(request, response) {
    const { application } = request.app.locals;

    try {
      const db = application.getWebmentionDb();
      if (!db) {
        return response.render("webmentions", {
          title: response.locals.__("webmention-io.title"),
          webmentions: [],
          counts: { total: 0, hidden: 0, visible: 0 },
          syncState: {
            ...getSyncState(),
            lastSync: formatDate(getSyncState().lastSync),
          },
          cursor: {},
          filter: "all",
          typeFilter: "all",
          wmEndpoint: application.webmentionEndpoint,
        });
      }

      const collection = db.collection("webmentions");

      const page = Number(request.query.page) || 0;
      const limit = Number(request.query.limit) || 20;
      const filter = request.query.filter || "all";
      const typeFilter = request.query.type || "all";

      // Build query options
      const queryOptions = {
        page,
        perPage: limit,
      };

      if (filter === "hidden") {
        queryOptions.showHidden = true;
      } else if (filter === "visible") {
        queryOptions.showHidden = false;
      } else {
        // "all" — show everything
        queryOptions.showHidden = true;
      }

      if (typeFilter !== "all") {
        queryOptions.wmProperty = typeFilter;
      }

      const { items, total } = await getWebmentions(collection, queryOptions);
      const counts = await getWebmentionCounts(collection);

      // Transform for the mention() macro
      const webmentions = items.map((item) => {
        let html;
        if (item.contentHtml) {
          html = item.contentHtml;
        }

        return {
          id: item.wmId,
          "wm-id": item.wmId,
          "wm-property": item.wmProperty,
          "wm-target": item.wmTarget,
          icon: getMentionType(item.wmProperty),
          locale: application.locale,
          title: getMentionTitle({ name: item.name, "wm-property": item.wmProperty }),
          description: html ? { html } : undefined,
          published: toISO(item.published || item.wmReceived),
          url: item.sourceUrl,
          user: {
            avatar: { src: item.authorPhoto },
            name: item.authorName || getAuthorName({
              author: { name: item.authorName, url: item.authorUrl },
              url: item.sourceUrl,
            }),
            url: item.authorUrl,
          },
          // Moderation metadata
          hidden: item.hidden,
          hiddenReason: item.hiddenReason,
          sourceDomain: item.sourceDomain,
        };
      });

      // Pagination cursor
      const cursor = {
        next: { href: `?page=${page + 1}&filter=${filter}&type=${typeFilter}` },
      };
      if (page > 0) {
        cursor.previous = { href: `?page=${page - 1}&filter=${filter}&type=${typeFilter}` };
      }

      response.render("webmentions", {
        title: response.locals.__("webmention-io.title"),
        webmentions,
        counts,
        syncState: {
          ...getSyncState(),
          lastSync: formatDate(getSyncState().lastSync),
        },
        cursor,
        filter,
        typeFilter,
        wmEndpoint: application.webmentionEndpoint,
      });
    } catch (error) {
      console.error("[Webmentions] Dashboard error:", error);
      response.status(500).render("error", {
        title: "Error",
        message: "Failed to load webmentions",
        error: error.message,
      });
    }
  },

  /**
   * POST /:wmId/hide - Hide a webmention
   */
  async hide(request, response) {
    const { application } = request.app.locals;

    try {
      const wmId = Number.parseInt(request.params.wmId, 10);
      const db = application.getWebmentionDb();
      const collection = db.collection("webmentions");

      await hideWebmention(collection, wmId, "manual");

      response.redirect(application.webmentionEndpoint + "?hidden=1");
    } catch (error) {
      console.error("[Webmentions] Hide error:", error);
      response.redirect(application.webmentionEndpoint + "?error=hide-failed");
    }
  },

  /**
   * POST /:wmId/unhide - Restore a webmention
   */
  async unhide(request, response) {
    const { application } = request.app.locals;

    try {
      const wmId = Number.parseInt(request.params.wmId, 10);
      const db = application.getWebmentionDb();
      const collection = db.collection("webmentions");

      await unhideWebmention(collection, wmId);

      response.redirect(application.webmentionEndpoint + "?unhidden=1");
    } catch (error) {
      console.error("[Webmentions] Unhide error:", error);
      response.redirect(application.webmentionEndpoint + "?error=unhide-failed");
    }
  },

  /**
   * POST /block - Block a domain
   */
  async blockDomainHandler(request, response) {
    const { application } = request.app.locals;

    try {
      const { domain } = request.body;
      if (!domain) {
        return response.redirect(application.webmentionEndpoint + "?error=no-domain");
      }

      const db = application.getWebmentionDb();
      const wmCollection = db.collection("webmentions");
      const blockCollection = db.collection("webmentionBlocklist");

      // Hide all existing mentions from this domain
      const hidden = await hideByDomain(wmCollection, domain, "blocklist");

      // Add to blocklist
      await blockDomain(blockCollection, domain, "spam", hidden);

      response.redirect(application.webmentionEndpoint + "?blocked=1&domain=" + encodeURIComponent(domain));
    } catch (error) {
      console.error("[Webmentions] Block error:", error);
      response.redirect(application.webmentionEndpoint + "?error=block-failed");
    }
  },

  /**
   * POST /privacy-remove - Privacy removal (delete + block)
   */
  async privacyRemove(request, response) {
    const { application } = request.app.locals;

    try {
      const { domain } = request.body;
      if (!domain) {
        return response.redirect(application.webmentionEndpoint + "/blocklist?error=no-domain");
      }

      const db = application.getWebmentionDb();
      const wmCollection = db.collection("webmentions");
      const blockCollection = db.collection("webmentionBlocklist");

      // Permanently delete all mentions from this domain
      const deleted = await deleteByDomain(wmCollection, domain);

      // Add to blocklist with privacy reason
      await blockDomain(blockCollection, domain, "privacy", deleted);

      response.redirect(application.webmentionEndpoint + "/blocklist?removed=1&count=" + deleted);
    } catch (error) {
      console.error("[Webmentions] Privacy remove error:", error);
      response.redirect(application.webmentionEndpoint + "/blocklist?error=remove-failed");
    }
  },
};
