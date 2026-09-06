/**
 * Dashboard controller
 * Admin UI for webmention moderation
 */

import { blockDomain } from "../storage/blocklist.js";
import { normaliseDomain } from "../utils.js";
import {
  getWebmentions,
  getWebmentionCounts,
  hideWebmention,
  unhideWebmention,
  hideByDomain,
  deleteByDomain,
} from "../storage/webmentions.js";
import { getSyncState } from "../sync.js";
import {
  getMentionType,
  getMentionTitle,
  getAuthorName,
  ensureISOString,
} from "../utils.js";

export const dashboardController = {
  /**
   * GET / - Webmentions dashboard
   * @param request
   * @param response
   */
  async list(request, response) {
    const { application } = request.app.locals;

    try {
      const database = application.getWebmentionDb();
      if (!database) {
        return response.render("webmentions", {
          title: response.locals.__("webmention-io.title"),
          webmentions: [],
          counts: { total: 0, hidden: 0, visible: 0 },
          syncState: getSyncState(),
          cursor: {},
          filter: "all",
          typeFilter: "all",
          wmEndpoint: application.webmentionEndpoint,
        });
      }

      const collection = database.collection("webmentions");

      const page = Number(request.query.page) || 0;
      const limit = Number(request.query.limit) || 20;
      const filter = request.query.filter || "all";
      const typeFilter = request.query.type || "all";

      // Build query options
      const queryOptions = {
        page,
        perPage: limit,
      };

      if (filter === "quarantine") {
        // Held for review: stored, hidden, and waiting on a decision.
        queryOptions.showHidden = true;
        queryOptions.hiddenReason = "quarantine";
      } else if (filter === "hidden") {
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
          title: getMentionTitle({
            name: item.name,
            "wm-property": item.wmProperty,
          }),
          description: html ? { html } : undefined,
          published:
            ensureISOString(item.published) || ensureISOString(item.wmReceived),
          url: item.sourceUrl,
          user: {
            avatar: item.authorPhoto ? { src: item.authorPhoto } : undefined,
            name:
              item.authorName ||
              getAuthorName({
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
        cursor.previous = {
          href: `?page=${page - 1}&filter=${filter}&type=${typeFilter}`,
        };
      }

      response.render("webmentions", {
        title: response.locals.__("webmention-io.title"),
        webmentions,
        counts,
        syncState: getSyncState(),
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
   * @param request
   * @param response
   */
  async hide(request, response) {
    const { application } = request.app.locals;

    try {
      const wmId = Number.parseInt(request.params.wmId, 10);
      const database = application.getWebmentionDb();
      const collection = database.collection("webmentions");

      await hideWebmention(collection, wmId, "manual");

      response.redirect(application.webmentionEndpoint + "?hidden=1");
    } catch (error) {
      console.error("[Webmentions] Hide error:", error);
      response.redirect(application.webmentionEndpoint + "?error=hide-failed");
    }
  },

  /**
   * POST /:wmId/unhide - Restore a webmention
   * @param request
   * @param response
   */
  async unhide(request, response) {
    const { application } = request.app.locals;

    try {
      const wmId = Number.parseInt(request.params.wmId, 10);
      const database = application.getWebmentionDb();
      const collection = database.collection("webmentions");

      await unhideWebmention(collection, wmId);

      response.redirect(application.webmentionEndpoint + "?unhidden=1");
    } catch (error) {
      console.error("[Webmentions] Unhide error:", error);
      response.redirect(
        application.webmentionEndpoint + "?error=unhide-failed",
      );
    }
  },

  /**
   * POST /block - Block a domain
   * @param request
   * @param response
   */
  async blockDomainHandler(request, response) {
    const { application } = request.app.locals;

    try {
      const { domain } = request.body;
      if (!domain) {
        return response.redirect(
          application.webmentionEndpoint + "?error=no-domain",
        );
      }

      const database = application.getWebmentionDb();
      const wmCollection = database.collection("webmentions");
      const blockCollection = database.collection("webmentionBlocklist");

      // Hide all existing mentions from this domain. Normalised because
      // mentions store sourceDomain as a bare hostname while this form
      // typically submits a full author URL.
      const target = normaliseDomain(domain) ?? domain;
      const hidden = await hideByDomain(wmCollection, target, "blocklist");

      // Add to blocklist
      await blockDomain(blockCollection, target, "spam", hidden);

      response.redirect(
        application.webmentionEndpoint +
          "?blocked=1&domain=" +
          encodeURIComponent(domain),
      );
    } catch (error) {
      console.error("[Webmentions] Block error:", error);
      response.redirect(application.webmentionEndpoint + "?error=block-failed");
    }
  },

  /**
   * POST /privacy-remove - Privacy removal (delete + block)
   * @param request
   * @param response
   */
  /**
   * POST /quarantine - hold a domain's future mentions for review
   *
   * Deliberately does not touch what is already stored: quarantine is for a
   * domain the operator is unsure about, so the history stays visible while
   * anything new waits for a decision. Promoting to a block later sweeps the
   * whole history, because blockDomainHandler does.
   * @type {import("express").RequestHandler}
   */
  async quarantineDomainHandler(request, response) {
    const { application } = request.app.locals;

    try {
      const { domain, reason } = request.body;
      if (!domain) {
        return response.redirect(
          application.webmentionEndpoint + "/blocklist?error=no-domain",
        );
      }

      const database = application.getWebmentionDb();
      const blockCollection = database.collection("webmentionBlocklist");
      const target = normaliseDomain(domain) ?? domain;

      await blockDomain(
        blockCollection,
        target,
        reason || "unsure",
        0,
        "quarantined",
      );

      response.redirect(
        application.webmentionEndpoint +
          "/blocklist?quarantined=1&domain=" +
          encodeURIComponent(target),
      );
    } catch (error) {
      console.error("[Webmentions] Quarantine error:", error);
      response.redirect(
        application.webmentionEndpoint + "/blocklist?error=quarantine-failed",
      );
    }
  },

  async privacyRemove(request, response) {
    const { application } = request.app.locals;

    try {
      const { domain } = request.body;
      if (!domain) {
        return response.redirect(
          application.webmentionEndpoint + "/blocklist?error=no-domain",
        );
      }

      const database = application.getWebmentionDb();
      const wmCollection = database.collection("webmentions");
      const blockCollection = database.collection("webmentionBlocklist");

      // Permanently delete all mentions from this domain
      const target = normaliseDomain(domain) ?? domain;
      const deleted = await deleteByDomain(wmCollection, target);

      // Add to blocklist with privacy reason
      await blockDomain(blockCollection, target, "privacy", deleted);

      response.redirect(
        application.webmentionEndpoint +
          "/blocklist?removed=1&count=" +
          deleted,
      );
    } catch (error) {
      console.error("[Webmentions] Privacy remove error:", error);
      response.redirect(
        application.webmentionEndpoint + "/blocklist?error=remove-failed",
      );
    }
  },
};
