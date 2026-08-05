/**
 * Maps backend — serialization boundary to the native maps-helper.
 * Standard contract: shape validation only, content carried verbatim, no
 * script text (DESIGN.md §5.1).
 */

import { z } from "zod";
import type { HelperRequest } from "../_template/module.ts";

export const SearchPlacesInput = z.object({
  query: z.string().min(1).max(500).describe("What to look for, e.g. 'coffee' or a place name."),
  near: z
    .object({
      latitude: z.number().min(-90).max(90).describe("Anchor latitude."),
      longitude: z.number().min(-180).max(180).describe("Anchor longitude."),
      radiusKm: z.number().min(0.5).max(200).default(10).describe("Search radius in km."),
    })
    .optional()
    .describe("Optional anchor. The server never looks up the user's own location."),
  limit: z.coerce.number().int().min(1).max(50).default(10).describe("Max results. Hard cap 50."),
});

export const DirectionsInput = z.object({
  from: z.string().min(1).max(500).describe("Start place or address."),
  to: z.string().min(1).max(500).describe("Destination place or address."),
  transport: z
    .enum(["driving", "walking"])
    .default("driving")
    .describe("Travel mode."),
});

export type { HelperRequest };

export function serializeSearchPlaces(input: unknown): HelperRequest {
  return { op: "maps.search", args: SearchPlacesInput.parse(input) };
}

export function serializeDirections(input: unknown): HelperRequest {
  return { op: "maps.directions", args: DirectionsInput.parse(input) };
}

/* Output shapes */

export const PlaceOut = z.object({
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});

export const RouteOut = z.object({
  name: z.string(),
  distanceMeters: z.number(),
  travelTimeSeconds: z.number(),
  transport: z.string(),
  steps: z.array(z.string()),
});
