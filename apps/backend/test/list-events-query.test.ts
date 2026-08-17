import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ListEventsQueryDto } from "../src/common/dto";

/**
 * `GET /events?batched=&quarantined=` is how the dashboard separates clean
 * events from quarantined ones, and how an operator finds the events still
 * waiting to be put in a batch. Both filters are booleans arriving as query
 * strings, which is the exact shape that silently inverts if it is converted
 * with `Boolean("false")`.
 */

/** What Nest's ValidationPipe does to the parsed query object. */
function parseQuery(query: Record<string, unknown>): {
  dto: ListEventsQueryDto;
  errors: string[];
} {
  const dto = plainToInstance(ListEventsQueryDto, query, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);
  return { dto, errors };
}

describe("ListEventsQueryDto — boolean filters", () => {
  it("reads ?quarantined=false as false, not as a truthy string", () => {
    const { dto, errors } = parseQuery({ quarantined: "false" });

    // The regression that matters: an operator asking for clean events must not
    // be handed the quarantined ones.
    expect(dto.quarantined).toBe(false);
    expect(errors).toEqual([]);
  });

  it("reads ?quarantined=true as true", () => {
    const { dto, errors } = parseQuery({ quarantined: "true" });
    expect(dto.quarantined).toBe(true);
    expect(errors).toEqual([]);
  });

  it("reads ?batched=false as false — the unbatched-events queue", () => {
    const { dto, errors } = parseQuery({ batched: "false" });
    expect(dto.batched).toBe(false);
    expect(errors).toEqual([]);
  });

  it("accepts 1 and 0, which is how some clients serialise booleans", () => {
    expect(parseQuery({ batched: "1", quarantined: "0" }).dto).toMatchObject({
      batched: true,
      quarantined: false,
    });
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseQuery({ quarantined: " FALSE " }).dto.quarantined).toBe(false);
    expect(parseQuery({ quarantined: "True" }).dto.quarantined).toBe(true);
  });

  it("passes through real booleans unchanged", () => {
    const { dto, errors } = parseQuery({ batched: true, quarantined: false });
    expect(dto).toMatchObject({ batched: true, quarantined: false });
    expect(errors).toEqual([]);
  });

  it("treats an omitted filter as no filter at all", () => {
    const { dto, errors } = parseQuery({});
    expect(dto.batched).toBeUndefined();
    expect(dto.quarantined).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("treats ?quarantined= (present but empty) as no filter rather than false", () => {
    const { dto, errors } = parseQuery({ quarantined: "" });
    expect(dto.quarantined).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("rejects a value it cannot interpret instead of guessing at it", () => {
    // Silently choosing true or false here would recreate the original bug in a
    // new form: a filter that answers a question nobody asked.
    expect(parseQuery({ quarantined: "maybe" }).errors).toEqual(["quarantined"]);
    expect(parseQuery({ batched: "yes" }).errors).toEqual(["batched"]);
  });

  it("still parses limit as a number and enforces its bounds", () => {
    expect(parseQuery({ limit: "10" }).dto.limit).toBe(10);
    expect(parseQuery({ limit: "10" }).errors).toEqual([]);
    expect(parseQuery({ limit: "501" }).errors).toEqual(["limit"]);
    expect(parseQuery({ limit: "0" }).errors).toEqual(["limit"]);
  });

  it("rejects a hubId that is not a uuid", () => {
    expect(parseQuery({ hubId: "not-a-uuid" }).errors).toEqual(["hubId"]);
  });
});
