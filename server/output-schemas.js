"use strict";

const string = Object.freeze({ type: "string" });

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

function outputSchema(requestMode) {
  if (requestMode === "connection-test") return CONNECTION_SCHEMA;
  if (requestMode === "fact-extraction") return FACT_SCHEMA;
  if (requestMode === "fact-reduction") return REDUCTION_SCHEMA;
  return SIREN_SCHEMA;
}

module.exports = { CONNECTION_SCHEMA, FACT_SCHEMA, REDUCTION_SCHEMA, SIREN_SCHEMA, outputSchema };
