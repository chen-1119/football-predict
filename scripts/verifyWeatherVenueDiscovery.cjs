"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseVenueCoordinates,
  nearestHourlyWeather,
  resolveLocation,
  teamCandidateMatches,
  teamLookupQuery,
  venueRetryDue,
} = require("./syncWeatherData.cjs");

const approx = (actual, expected, epsilon = 0.0001) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
};

const dms = parseVenueCoordinates("34°43′03.6″S 58°23′01.7″W");
assert.ok(dms);
approx(dms.latitude, -34.7176667);
approx(dms.longitude, -58.3838056);

assert.deepEqual(parseVenueCoordinates("51.5567, -0.1061"), {
  latitude: 51.5567,
  longitude: -0.1061,
});
assert.equal(parseVenueCoordinates("not a coordinate"), null);

assert.equal(teamCandidateMatches("arsenal", {
  strSport: "Soccer",
  strTeam: "Arsenal FC",
  strTeamAlternate: "Arsenal Football Club, AFC",
}), true);
assert.equal(teamCandidateMatches("arsenal", { strSport: "Basketball", strTeam: "Arsenal" }), false);
assert.equal(teamCandidateMatches("arsenal", { strSport: "Soccer", strTeam: "Chelsea" }), false);

assert.equal(teamLookupQuery({ homeTeamName: "阿森纳" }), "arsenal");
assert.equal(teamLookupQuery({ homeTeamName: "未知球队" }), "");

const teamLocation = {
  name: "Emirates Stadium",
  city: "London",
  country: "England",
  latitude: 51.5567,
  longitude: -0.1061,
  verified: false,
  source: "thesportsdb-free-team-venue",
};

assert.equal(venueRetryDue({ attemptedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }), true);
assert.equal(venueRetryDue({ attemptedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }), false);
assert.equal(venueRetryDue({ attemptedAt: "invalid" }), true);
assert.deepEqual(resolveLocation({ id: "sporttery_1", homeTeamId: "team_arsenal" }, {
  matches: {},
  teams: { team_arsenal: teamLocation },
}, 0), teamLocation);
const matchVenue = {
  name: "Neutral venue",
  city: "Cardiff",
  country: "Wales",
  latitude: 51.478,
  longitude: -3.182,
  verified: true,
  source: "official-match-centre",
};
assert.deepEqual(resolveLocation({
  id: "sporttery_2",
  homeTeamId: "team_arsenal",
  externalSignals: { venue: matchVenue },
}, {
  matches: {},
  teams: { team_arsenal: teamLocation },
}, 0), matchVenue);
assert.equal(resolveLocation({
  id: "sporttery_3",
  externalSignals: { venue: { latitude: null, longitude: null } },
}, { matches: {}, teams: {} }, 0), null);
assert.equal(nearestHourlyWeather({ hourly: {
  time: ["2026-09-29T12:00"],
  temperature_2m: [null],
  precipitation: [0],
  wind_speed_10m: [10],
} }, Date.parse("2026-09-29T12:00:00Z")), null);

const source = fs.readFileSync(path.join(__dirname, "syncWeatherData.cjs"), "utf8");
assert.match(source, /reference-only-until-human-verified/);
assert.match(source, /WEATHER_VENUE_DISCOVERY_MAX_TEAMS/);
assert.match(source, /WEATHER_VENUE_DISCOVERY_RETRY_MINUTES/);
assert.match(source, /thesportsdb-free-team-venue/);
assert.match(source, /locations\?\.teams/);

console.log(JSON.stringify({
  ok: true,
  checks: 22,
  source: "TheSportsDB free team/venue lookup + Open-Meteo forecast",
  semantics: "provider venue mappings remain reference-only until reviewed",
}, null, 2));
