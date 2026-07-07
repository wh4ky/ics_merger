import ICAL from "ical.js";

import http from 'node:http';
import process, { env } from 'node:process';

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

if (!env.PORT) {
    try {
        console.log("loading env file");
        process.loadEnvFile("./.env");
    } catch (_e) { /* */ }
    finally {
        // deno-lint-ignore no-unsafe-finally
        if (!env.PORT) throw new Error("PORT environment variable not set");
    }
}

const calendars = Object.fromEntries(Object.keys(env).map((e, _f, g) => {
    const match = e.match(/^CAL(\d*)(_URL)?$/i);
    const src = match?.[0].replace("_URL", "").concat("_SRC");
    if (match) {
        const matches = g.filter(e => e.startsWith(src!) && e.slice(src!.length).match(/^\d*$/));
        return [env[e], matches.map(src => env[src])] as [string, string[]];
    }
}).filter(e => e != undefined));
http.createServer(async (req, res) => {
    let sources: string[] = [];
    switch (Object.keys(calendars).includes(req.url!.slice(1))) {
        case true: {
            sources = calendars[req.url!.slice(1)];
            break;
        }
        default: {
            res.statusCode = 404;
            res.end("not found\n");
            break;
        };
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
            const ic_events = ic.getAllSubcomponents("vevent").filter(component => {
                const event = new ICAL.Event(component);
                try { return !event.isRecurring() || event.iterator().next() != null; } catch (_e) { return false; }
            }).sort((a, b) => +a.hasProperty("recurrence-id") - +b.hasProperty("recurrence-id"));

            ic_events.map(component => new ICAL.Event(component)).forEach(event => event.uid = `${idx}-${event.uid}`);
            events.push(...ic_events);
        } catch (e) { console.log("error", e); }
    }

    const tzs = timezones.map(component => new ICAL.Timezone(component));
    const tzids = [...new Set(tzs.map(tz => tz.tzid))];
    const tzcs: ICAL.Component[] = [];
    for (const tzid of tzids) {
        const mtzs = tzs.filter(tz => tz.tzid == tzid);
        if (new Set(mtzs.map(tz => tz.toString())).size !== 1) console.log(`[WARN] not all timezone definitions for ${tzid} are equal, using the first definition`);
        tzcs.push(mtzs[0].component);
    }

    const cal = new ICAL.Component("vcalendar");
    [
        ["prodid", {}, "text", "-//ical.js//ical merger//EN"],
        ["version", {}, "text", "2.0"],
        ["calscale", {}, "text", "GREGORIAN"],
        ["method", {}, "text", "PUBLISH"],
    ].forEach(prop => cal.addProperty(new ICAL.Property(prop)));
    tzcs.forEach(tz => cal.addSubcomponent(tz));
    events.forEach(e => cal.addSubcomponent(e));

    res.writeHead(200, "OK", {
        "content-type": "text/calendar; charset=utf-8"
    });
    res.write(cal.toString());
    res.end();
}).listen(+env.PORT, env.HOST ?? "0.0.0.0", () => console.log(`listening ${env.HOST ?? "0.0.0.0"}:${env.PORT}`));
