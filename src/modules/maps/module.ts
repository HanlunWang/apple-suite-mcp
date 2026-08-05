/**
 * Maps module (MapKit via maps-helper). Read-only: place search and route
 * summaries. Needs no macOS permission, but does reach Apple's map service —
 * hence openWorldHint on both tools.
 */

import { z } from "zod";
import type { HelperClient } from "../../native/client.ts";
import { sharedMapsClient } from "../../native/maps.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  DirectionsInput,
  PlaceOut,
  RouteOut,
  SearchPlacesInput,
  serializeDirections,
  serializeSearchPlaces,
} from "./backend.ts";

export function createMapsModule(client: HelperClient = sharedMapsClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }) =>
    client.call<T>(req.op, req.args);

  const readTools: ToolDef[] = [
    {
      name: "maps_search_places",
      title: "Search places",
      description:
        "Search Apple Maps for places by name or category, optionally around " +
        "a coordinate. Returns names, coordinates, addresses. Does NOT know " +
        "the user's current location — pass `near` explicitly if needed.",
      inputSchema: SearchPlacesInput.shape,
      outputSchema: { places: z.array(PlaceOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "maps.search",
      annotations: { idempotentHint: true, openWorldHint: true },
      run: async (input) => ({
        places: await call(serializeSearchPlaces(input)),
        _untrusted: true,
      }),
    },
    {
      name: "maps_directions",
      title: "Get directions",
      description:
        "Get a route summary (distance, travel time, turn list) between two " +
        "places. Both endpoints are resolved by name/address first.",
      inputSchema: DirectionsInput.shape,
      outputSchema: { route: RouteOut, _untrusted: z.boolean() },
      mode: "read",
      actionId: "maps.directions",
      annotations: { idempotentHint: true, openWorldHint: true },
      run: async (input) => ({
        route: await call(serializeDirections(input)),
        _untrusted: true,
      }),
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "maps://search{?query,limit}",
      name: "maps-search",
      title: "Place search",
      description: "Places matching a query, as JSON.",
      read: async (_uri, params) => await call(serializeSearchPlaces(params)),
    },
  ];

  return {
    id: "maps",
    resources: () => resources,
    tools: (_mode: Mode) => readTools,
  };
}
