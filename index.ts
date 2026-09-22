import ICAL from "ical.js";

import http from "node:http";
import process, { env } from "node:process";
import fs from "node:fs";

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

type Config = {
  port: number;
  host: string;

  urls: Record<string, string[]>;
};

// Read config
let conf: Config = {} as Config;
try {
  console.log("Loading config...");
  conf = JSON.parse(fs.readFileSync("./config.json", "utf8"));

  fs.watchFile("./config.json", (_c, _p) => {
    console.log("Config has changed, updating...");
    try {
      const conf_new: Config = JSON.parse(
        fs.readFileSync("./config.json", "utf8"),
      );
      conf.urls = conf_new.urls;
      console.log("Config successfully updated!");
    } catch (e) {
      console.error(
        `Error loading new config.json: ${(e as Error).message
        }\nGoing back to using old config.`,
      );
    }
  });
} catch (e) {
  console.error(`Error loading config.json: ${(e as Error).message}`);

  if (!env.PORT) {
    try {
      console.log("Loading env...");
      process.loadEnvFile("./.env");
    } catch (e) {
      console.error(e);
    } finally {
      // deno-lint-ignore no-unsafe-finally
      if (!env.PORT) throw new Error("PORT environment variable not set");
    }
  }

  conf.port = +env.PORT;
  conf.host = env.HOST ?? "0.0.0.0";

  conf.urls = Object.fromEntries(
    Object.keys(env).map((key, _, all) => {
      const match = key.match(/^CAL(\d*)(_URL)?$/i);
      if (!match) return undefined;
      const src = match[0].toUpperCase().replace("_URL", "").concat("_SRC");
      const matches = all.filter((key) =>
        key.startsWith(src!.toUpperCase()) &&
        key.slice(src!.length).match(/^\d*$/)
      );
      return [env[key], matches.map((src) => env[src])] as [string, string[]];
    }).filter((key) => key != undefined),
  );
}

// Start server
http.createServer(async (req, res) => {
  let sources: string[] = [];
  switch (Object.keys(conf.urls).includes(req.url!.slice(1))) {
    case true: {
      sources = conf.urls[req.url!.slice(1)];
      break;
    }
    default: {
      res.statusCode = 404;
      res.end("not found\n");
      return;
    }
  }

  const timezones = [];
  const events = [];

  for (const idx in sources) {
    try {
      const calendar = sources[idx];
      console.log(`fetching ${calendar}`);
      const ical = await (await fetch(calendar)).text();
      const i = ICAL.parse(ical);
      const ic = new ICAL.Component(i);

      timezones.push(...ic.getAllSubcomponents("vtimezone"));

      // solve common ics parsing issues https://github.com/przemub/ics_caldav_sync/pull/20
      const ic_events = ic.getAllSubcomponents("vevent").filter((component) => {
        const event = new ICAL.Event(component);
        try {
          return !event.isRecurring() || event.iterator().next() != null;
        } catch (_e) {
          return false;
        }
      }).sort((a, b) =>
        +a.hasProperty("recurrence-id") - +b.hasProperty("recurrence-id")
      );

      ic_events.map((component) => new ICAL.Event(component)).forEach((event) =>
        event.uid = `${idx}-${event.uid}`
      );
      events.push(...ic_events);
    } catch (e) {
      console.log("error", e);
    }
  }

  const tzs = timezones.map((component) => new ICAL.Timezone(component));
  const tzids = [...new Set(tzs.map((tz) => tz.tzid))];
  const tzcs: ICAL.Component[] = [];
  for (const tzid of tzids) {
    const mtzs = tzs.filter((tz) => tz.tzid == tzid);
    if (new Set(mtzs.map((tz) => tz.toString())).size !== 1) {
      console.log(
        `[WARN] not all timezone definitions for ${tzid} are equal, using the first definition`,
      );
    }
    tzcs.push(mtzs[0].component);
  }

  const cal = new ICAL.Component("vcalendar");
  [
    ["prodid", {}, "text", "-//ical.js//ical merger//EN"],
    ["version", {}, "text", "2.0"],
    ["calscale", {}, "text", "GREGORIAN"],
    ["method", {}, "text", "PUBLISH"],
  ].forEach((prop) => cal.addProperty(new ICAL.Property(prop)));
  tzcs.forEach((tz) => cal.addSubcomponent(tz));
  events.forEach((e) => cal.addSubcomponent(e));

  res.writeHead(200, "OK", {
    "content-type": "text/calendar; charset=utf-8",
  });
  res.write(cal.toString());
  res.end();
}).listen(
  conf.port,
  conf.host,
  () => console.log(`listening ${conf.host}:${conf.port}`),
);
