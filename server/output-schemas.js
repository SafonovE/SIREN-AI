"use strict";
const { sourceLines } = require("./source-lines");

const string = Object.freeze({ type: "string" });
const strings = { type: "array", items: string };
const record = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const records = (properties) => ({ type: "array", items: record(properties) });
const bool = { type: "boolean" };
const TOPIC_SCHEMAS = Object.freeze({
  "topic-extract": record({ coverage: { type: "string", enum: ["complete"] }, facts: records({ statement: string, startLine: { type: "integer", minimum: 0 }, endLine: { type: "integer", minimum: 0 } }), irrelevantReason: string, warnings: strings }),
  "topic-inspect": record({ decisions: records({ factId: string, keep: bool, supported: bool }), clarifications: { ...records({ question: { type: "string", maxLength: 180 }, reason: { type: "string", maxLength: 300 }, factIds: strings }), maxItems: 3 }, warnings: strings }),
  "topic-compose": record({ fields: { ...records({ path: { type: "string", enum: ["title", "groups[0].items[0].before", "groups[0].items[0].after", "groups[0].items[0].clientAction", "groups[0].items[0].supportNote", "support.say"] }, text: string, factIds: { ...strings, minItems: 1 } }), maxItems: 6 }, warnings: strings }),
  "topic-audit": record({ checks: records({ path: string, supported: bool, relevant: bool }), missingFactIds: strings, warnings: strings }),
});

const FACT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    coverage: { type: "string", enum: ["complete"] },
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: { statement: string, quote: string },
        required: ["statement", "quote"],
        additionalProperties: false,
      },
    },
    irrelevantReason: string,
    warnings: { type: "array", items: string },
  },
  required: ["coverage", "facts", "irrelevantReason", "warnings"],
  additionalProperties: false,
});

const REDUCTION_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: string,
          quote: string,
          sourceFactIds: { type: "array", items: string },
        },
        required: ["statement", "quote", "sourceFactIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["facts"],
  additionalProperties: false,
});

const CONNECTION_SCHEMA = Object.freeze({
  type: "object",
  properties: { ready: { type: "boolean", const: true } },
  required: ["ready"],
  additionalProperties: false,
});

const ITEM_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    title: string,
    before: string,
    after: string,
    clientAction: string,
    supportNote: string,
  },
  required: ["title", "before", "after", "clientAction", "supportNote"],
  additionalProperties: false,
});

const GROUP_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    title: string,
    channels: { type: "array", items: { type: "string", enum: ["ios", "android", "web"] } },
    location: string,
    availability: string,
    items: { type: "array", items: ITEM_SCHEMA },
    screenshots: { type: "array", maxItems: 0 },
  },
  required: ["title", "channels", "location", "availability", "items", "screenshots"],
  additionalProperties: false,
});

const FAQ_SCHEMA = Object.freeze({
  type: "object",
  properties: { question: string, answer: string },
  required: ["question", "answer"],
  additionalProperties: false,
});

const PROPOSAL_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    title: string,
    releaseDate: string,
    rolloutMode: string,
    rolloutConditions: string,
    groups: { type: "array", items: GROUP_SCHEMA },
    support: {
      type: "object",
      properties: {
        say: string,
        dontSay: string,
        details: string,
        faq: { type: "array", items: FAQ_SCHEMA },
      },
      required: ["say", "dontSay", "details", "faq"],
      additionalProperties: false,
    },
  },
  required: ["title", "releaseDate", "rolloutMode", "rolloutConditions", "groups", "support"],
  additionalProperties: false,
});

const EVIDENCE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    path: string,
    sourceId: string,
    page: { anyOf: [{ type: "integer" }, { type: "null" }] },
    snippet: string,
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["path", "sourceId", "page", "snippet", "confidence"],
  additionalProperties: false,
});

const SIREN_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    schemaVersion: { type: "integer", const: 4 },
    proposal: PROPOSAL_SCHEMA,
    evidence: { type: "array", items: EVIDENCE_SCHEMA },
    warnings: { type: "array", items: string },
    unknowns: { type: "array", items: string },
  },
  required: ["schemaVersion", "proposal", "evidence", "warnings", "unknowns"],
  additionalProperties: false,
});

function outputSchema(requestMode, context = {}) {
  if (TOPIC_SCHEMAS[requestMode]) {
    const ids = (context.topicFacts || []).map((fact) => fact.factId);
    const schema = JSON.parse(JSON.stringify(TOPIC_SCHEMAS[requestMode]));
    if (requestMode === "topic-extract") {
      const file = context.files?.[0] || {};
      const count = sourceLines(file.text).length;
      const visual = file.kind === "image" && Boolean(file.buffer?.length);
      const properties = schema.properties.facts.items.properties;
      for (const key of ["startLine", "endLine"]) properties[key] = { type: "integer", minimum: visual ? 0 : 1, maximum: Math.max(visual ? 0 : 1, count) };
      return schema;
    }
    if (!ids.length) return schema;
    const constrain = (value, name = "") => {
      if (!value || typeof value !== "object") return;
      if (name === "factId") value.enum = ids;
      if (["factIds", "missingFactIds"].includes(name)) value.items = { type: "string", enum: ids };
      if (name === "path" && requestMode === "topic-audit" && context.topicFields?.length) value.enum = context.topicFields.map((field) => field.path);
      for (const [key, item] of Object.entries(value)) if (key !== "enum") constrain(item, key);
    };
    constrain(schema);
    if (requestMode === "topic-inspect") schema.properties.decisions.minItems = schema.properties.decisions.maxItems = ids.length;
    if (requestMode === "topic-audit" && context.topicFields?.length) schema.properties.checks.minItems = schema.properties.checks.maxItems = context.topicFields.length;
    return schema;
  }
  if (requestMode === "connection-test") return CONNECTION_SCHEMA;
  if (requestMode === "fact-extraction") return FACT_SCHEMA;
  if (requestMode === "fact-reduction") return REDUCTION_SCHEMA;
  return SIREN_SCHEMA;
}

module.exports = { CONNECTION_SCHEMA, FACT_SCHEMA, REDUCTION_SCHEMA, SIREN_SCHEMA, outputSchema };
