import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ensureUser, getOwner, getUser, requireMember } from "./lib/auth";
import { getDocument, liveBlocks, ownTemplate } from "./lib/document";
import type { TemplateSection } from "./lib/document";
import { templateSection } from "./schema";

// Robert's document templates. Atelier's default is a constant in
// lib/document.ts and is used when a room is created without a template.

const requireTemplateOwner = async (ctx: QueryCtx) => {
  if (!(await getOwner(ctx))) {
    throw new Error("Only the owner can manage templates");
  }
};

const clean = (name: string, sections: TemplateSection[]) => {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("A template needs a name");
  }
  return {
    name: trimmed,
    sections: sections.map(({ heading, guidance }) => {
      const h = heading.trim();
      if (!h) {
        throw new Error("Every section needs a heading");
      }
      const g = guidance?.trim();
      return g === undefined || g === ""
        ? { heading: h }
        : { guidance: g, heading: h };
    }),
  };
};

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireTemplateOwner(ctx);
    const user = await getUser(ctx);
    if (!user) {
      return [];
    }
    const rows = await ctx.db
      .query("templates")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect();
    return rows.map((t) => ({
      _id: t._id,
      name: t.name,
      sections: t.sections,
    }));
  },
});

export const create = mutation({
  args: { name: v.string(), sections: v.array(templateSection) },
  handler: async (ctx, { name, sections }) => {
    await requireTemplateOwner(ctx);
    const user = await ensureUser(ctx);
    return await ctx.db.insert("templates", {
      ownerUserId: user._id,
      ...clean(name, sections),
    });
  },
});

export const update = mutation({
  args: {
    name: v.string(),
    sections: v.array(templateSection),
    templateId: v.id("templates"),
  },
  handler: async (ctx, { templateId, name, sections }) => {
    await requireTemplateOwner(ctx);
    await ownTemplate(ctx, templateId);
    await ctx.db.patch(templateId, clean(name, sections));
  },
});

// Rooms seeded from a removed template keep their document.
export const remove = mutation({
  args: { templateId: v.id("templates") },
  handler: async (ctx, { templateId }) => {
    await requireTemplateOwner(ctx);
    await ownTemplate(ctx, templateId);
    await ctx.db.delete(templateId);
  },
});

// Saves a room's section structure as a new template: its headings, and the
// template guidance under them that nobody has changed. Nothing anyone wrote
// in the room is copied.
export const saveFromRoom = mutation({
  args: { name: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { roomId, name }) => {
    await requireTemplateOwner(ctx);
    await requireMember(ctx, roomId);
    const user = await ensureUser(ctx);
    const document = await getDocument(ctx, roomId);
    const sections: TemplateSection[] = [];
    for (const block of document ? await liveBlocks(ctx, document._id) : []) {
      if (block.kind === "heading") {
        sections.push({ heading: block.text });
      } else if (block.fromTemplate === true) {
        const last = sections.at(-1);
        if (last !== undefined) {
          last.guidance =
            last.guidance === undefined || last.guidance === ""
              ? block.text
              : `${last.guidance}\n\n${block.text}`;
        }
      }
    }
    return await ctx.db.insert("templates", {
      ownerUserId: user._id,
      ...clean(name, sections),
    });
  },
});
