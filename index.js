const axios = require("axios");
const dotenv = require("dotenv");
dotenv.config();

const token = process.env.HUBSPOT_TOKEN;

if (!token) {
  throw new Error("Missing HUBSPOT_TOKEN environment variable");
}

const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "createdate",
  "client_type",
  "first_conversion_date",
  "recent_conversion_date",
  "hs_analytics_source",
  "hs_analytics_source_data_1",
  "hs_analytics_source_data_2",
  "hs_latest_source",
  "hs_latest_source_data_1",
  "hs_latest_source_data_2",
  "first_conversion_event_name",
  "recent_conversion_event_name",
  "engagements_last_meeting_booked_source",
  "engagements_last_meeting_booked_medium",
  "lead_campaign_engagement_date",
  "first_call_date_ad",
];

// walks the paginated memberships endpoint to collect every contact id in the list,
// along with the timestamp each one was added to it
const fetchListMemberships = async (id) => {
  const memberships = [];
  let after;

  do {
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/lists/${id}/memberships`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: after ? { after } : undefined,
      },
    );
    memberships.push(
      ...response.data.results.map((r) => ({
        recordId: r.recordId,
        addedAt: r.membershipTimestamp,
      })),
    );
    after = response.data.paging?.next?.after;
  } while (after);

  return memberships;
};

// HubSpot's batch read caps at 100 ids per request
const chunk = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

const fetchContactsByIds = async (ids) => {
  const contacts = [];

  for (const batch of chunk(ids, 100)) {
    const response = await axios.post(
      `https://api.hubapi.com/crm/v3/objects/contacts/batch/read`,
      {
        properties: CONTACT_PROPERTIES,
        inputs: batch.map((id) => ({ id: String(id) })),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
    contacts.push(...response.data.results);
  }

  return contacts;
};

const fetchCallAssociations = async (contactIds) => {
  const callIdsByContactId = new Map();

  for (const batch of chunk(contactIds, 100)) {
    const response = await axios.post(
      `https://api.hubapi.com/crm/v4/associations/contacts/calls/batch/read`,
      { inputs: batch.map((id) => ({ id: String(id) })) },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    for (const result of response.data.results) {
      callIdsByContactId.set(
        result.from.id,
        result.to.map((call) => String(call.toObjectId)),
      );
    }
  }

  return callIdsByContactId;
};

const fetchCallsByIds = async (callIds) => {
  const timestampByCallId = new Map();

  for (const batch of chunk(callIds, 100)) {
    const response = await axios.post(
      `https://api.hubapi.com/crm/v3/objects/calls/batch/read`,
      {
        properties: ["hs_timestamp"],
        inputs: batch.map((id) => ({ id })),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    for (const call of response.data.results) {
      timestampByCallId.set(call.id, call.properties.hs_timestamp);
    }
  }

  return timestampByCallId;
};

// across all segments a contact is in (within this run), keep only the
// earliest membership — that's the date (and channel) we credit them with
const findEarliestMemberships = async (segments) => {
  const earliestByContactId = new Map();

  for (const segment of segments) {
    const memberships = await fetchListMemberships(segment.id);

    for (const { recordId, addedAt } of memberships) {
      const id = String(recordId);
      const existing = earliestByContactId.get(id);

      if (!existing || new Date(addedAt) < new Date(existing.addedAt)) {
        earliestByContactId.set(id, {
          addedAt,
          channel: segment.channel,
          segment: segment.segment,
        });
      }
    }
  }

  return earliestByContactId;
};

const fetchAllSegmentContacts = async (segments) => {
  const earliestByContactId = await findEarliestMemberships(segments);
  const contacts = await fetchContactsByIds([...earliestByContactId.keys()]);

  return contacts.map((contact) => {
    const membership = earliestByContactId.get(contact.id);
    return {
      ...contact,
      addedToSegmentAt: membership.addedAt,
      channel: membership.channel,
      segment: membership.segment,
    };
  });
};

const PROSPECT_CLIENT_TYPES = [
  "Prospective Client",
  "Prospective Advisor",
  "McGrath & CO - Prospective Tenants",
  "House of McGrath - Prospective Client",
];

const EXISTING_CLIENT_EXCLUDED_TYPES = [
  "Prospective Client",
  "Prospective Advisor",
  "House of McGrath Client",
  "McGrath & CO - Prospective Tenants",
  "House of McGrath - Prospective Client",
  "Current Employee",
];

const startOfDay = (isoString) => {
  const d = new Date(isoString);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// calendar-day difference between when the contact was created and when it was
// added to the segment, ignoring time-of-day
const daysBeforeSegment = (createdate, addedToSegmentAt) => {
  const msPerDay = 24 * 60 * 60 * 1000;
  return (startOfDay(addedToSegmentAt) - startOfDay(createdate)) / msPerDay;
};

const NEW_LEAD_WINDOW_DAYS = 15;
const FIRST_CONVERSION_NEW_LEAD_WINDOW_DAYS = 30;

const isNewLead = (contact) => {
  const { createdate, first_conversion_date: firstConversionDate } =
    contact.properties;
  const diffDays = daysBeforeSegment(createdate, contact.addedToSegmentAt);

  if (diffDays <= NEW_LEAD_WINDOW_DAYS) {
    return true;
  }

  const isFirstConversion =
    firstConversionDate &&
    startOfDay(firstConversionDate) === startOfDay(createdate);

  return isFirstConversion && diffDays <= FIRST_CONVERSION_NEW_LEAD_WINDOW_DAYS;
};

const getEngagementType = (contact) => {
  const clientType = contact.properties.client_type;

  if (clientType === "Current Employee") {
    return "Internal Users";
  }

  if (PROSPECT_CLIENT_TYPES.includes(clientType)) {
    return isNewLead(contact) ? "New Lead" : "Existing Lead – Re-engaged";
  }

  if (clientType && !EXISTING_CLIENT_EXCLUDED_TYPES.includes(clientType)) {
    return "Existing Clients/Advisors";
  }

  return null;
};

// dates that land within this tolerance of each other are treated as the
// same event (createdate vs recent_conversion_date/addedToSegmentAt, and
// recent_conversion_date vs addedToSegmentAt)
const CREATEDATE_TOLERANCE_MS = 10 * 60 * 1000;

const isSameMoment = (a, b, toleranceMs) =>
  Math.abs(new Date(a) - new Date(b)) <= toleranceMs;

// addedToSegmentAt (the list's membershipTimestamp) gets reset to the merge
// moment when a contact is merged, so it can't be trusted on its own —
// recent_conversion_date/first_conversion_date survive merges and are used
// to recover the real date whenever they predate it
//
// how far back a conversion date can be and still count as belonging to this
// campaign's engagement, rather than some unrelated older conversion
const ENGAGEMENT_DATE_LOOKBACK_DAYS = 60;
const ENGAGEMENT_DATE_LOOKBACK_MS =
  ENGAGEMENT_DATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

const isEarlierCandidate = (date, createdate, addedToSegmentAt) => {
  if (!date || isSameMoment(createdate, date, CREATEDATE_TOLERANCE_MS)) {
    return false;
  }

  const gapMs = new Date(addedToSegmentAt) - new Date(date);
  return (
    gapMs >= CREATEDATE_TOLERANCE_MS && gapMs <= ENGAGEMENT_DATE_LOOKBACK_MS
  );
};

// picks the earliest genuinely-distinct, earlier date among
// recent_conversion_date / first_conversion_date / added-to-segment date.
// createdate === addedToSegmentAt short-circuits to createdate; everything
// else falls back to added-to-segment date when no earlier candidate exists
const getEngagementDate = (contact) => {
  const {
    createdate,
    recent_conversion_date: recentConversionDate,
    first_conversion_date: firstConversionDate,
  } = contact.properties;
  const addedToSegmentAt = contact.addedToSegmentAt;

  if (isSameMoment(createdate, addedToSegmentAt, CREATEDATE_TOLERANCE_MS)) {
    return createdate;
  }

  const earlierCandidates = [recentConversionDate, firstConversionDate].filter(
    (date) => isEarlierCandidate(date, createdate, addedToSegmentAt),
  );

  if (earlierCandidates.length > 0) {
    return earlierCandidates.reduce((earliest, date) =>
      new Date(date) < new Date(earliest) ? date : earliest,
    );
  }

  return addedToSegmentAt;
};

// short platform codes seen as a leading token in drill-down text (e.g. "fb
// / complimentary financial planning - book a call - ad set") and as the
// full value of engagements_last_meeting_booked_source
const AD_PLATFORM_CODES = {
  fb: "Facebook",
  facebook: "Facebook",
  ig: "Instagram",
  linkedin: "LinkedIn",
  adwords: "Google",
  instagram: "Instagram",
};

const matchAdPlatform = (value) => {
  if (!value) return null;

  const lower = value.toLowerCase();
  if (lower.includes("facebook")) return "Facebook";
  if (lower.includes("linkedin")) return "LinkedIn";
  if (lower.includes("google")) return "Google";

  const leadingToken = lower.trim().split(/[\s/-]+/)[0];
  return AD_PLATFORM_CODES[leadingToken] ?? null;
};

// matches every value in the tier (e.g. both the original- and latest-side
// field) and combines distinct platforms found, so a contact whose first
// conversion was Facebook and whose most recent was LinkedIn reports both
// instead of only the first match
const matchAdPlatformTier = (values) => {
  const matches = [];

  for (const value of values) {
    const match = matchAdPlatform(value);
    if (match && !matches.includes(match)) {
      matches.push(match);
    }
  }

  return matches.length > 0 ? matches.join(", ") : null;
};

// "{site_source_name}" is an unresolved HubSpot merge field left over when
// the source couldn't be filled in directly, but paired with a "paid" medium
// it's consistently a Facebook booking in this account's data
const matchMeetingBookingSource = (source, medium) => {
  if (source === "{site_source_name}" && medium?.toLowerCase() === "paid") {
    return "Facebook";
  }

  return AD_PLATFORM_CODES[source?.toLowerCase()] ?? null;
};

// walks original/first-side signals before latest/recent-side ones at each
// tier, from most specific (the actual conversion name) to least (generic
// drill-down text); PAID_SEARCH is treated as Google since that's the only
// paid-search platform this account runs (confirmed via the "Auto-tagged
// PPC" drill-down signature). Last resort, for contacts that would otherwise
// fall back to Direct Traffic, checks the meeting-booking source. Falls back
// to Direct Traffic when nothing indicates a real ad platform
const getLeadSourceAd = (contact) => {
  const {
    first_conversion_event_name: firstConversionEventName,
    recent_conversion_event_name: recentConversionEventName,
    hs_analytics_source_data_1: originalDrillDown1,
    hs_latest_source_data_1: latestDrillDown1,
    hs_analytics_source: originalSource,
    hs_latest_source: latestSource,
    hs_analytics_source_data_2: originalDrillDown2,
    hs_latest_source_data_2: latestDrillDown2,
    engagements_last_meeting_booked_source: meetingBookingSource,
    engagements_last_meeting_booked_medium: meetingBookingMedium,
  } = contact.properties;

  const conversionMatch = matchAdPlatformTier([
    firstConversionEventName,
    recentConversionEventName,
  ]);
  if (conversionMatch) return conversionMatch;

  const drillDown1Match = matchAdPlatformTier([
    originalDrillDown1,
    latestDrillDown1,
  ]);
  if (drillDown1Match) return drillDown1Match;

  if (originalSource === "PAID_SEARCH" || latestSource === "PAID_SEARCH") {
    return "Google";
  }

  const drillDown2Match = matchAdPlatformTier([
    originalDrillDown2,
    latestDrillDown2,
  ]);
  if (drillDown2Match) return drillDown2Match;

  const meetingBookingMatch = matchMeetingBookingSource(
    meetingBookingSource,
    meetingBookingMedium,
  );
  if (meetingBookingMatch) return meetingBookingMatch;

  return "Direct Traffic";
};

const BUSINESS_TIMEZONE = "America/Toronto";
const BUSINESS_START = { hour: 9, minute: 0 };
const BUSINESS_END = { hour: 17, minute: 30 };
const MS_PER_MINUTE = 60 * 1000;

// the calendar date (in timeZone) an instant falls on, as plain numbers
const getLocalDateParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
};

// timeZone's UTC offset (minutes, local - UTC) at the given instant
const getZoneOffsetMinutes = (date, timeZone) => {
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName").value;

  const match = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  return sign * (hours * 60 + minutes);
};

// the UTC instant corresponding to a wall-clock time on a given calendar
// date in timeZone (e.g. 8:30am on 2026-09-18 in America/Toronto)
const localWallTimeToUtc = (year, month, day, { hour, minute }, timeZone) => {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMinutes = getZoneOffsetMinutes(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offsetMinutes * MS_PER_MINUTE);
};

// sums the minutes of [start, end] that fall within the Mon-Fri
// BUSINESS_START-BUSINESS_END window (in BUSINESS_TIMEZONE), walking one
// calendar day at a time so multi-day gaps correctly skip nights/weekends
const businessMinutesBetween = (startIso, endIso) => {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!(end > start)) return 0;

  let { year, month, day } = getLocalDateParts(start, BUSINESS_TIMEZONE);
  const endParts = getLocalDateParts(end, BUSINESS_TIMEZONE);

  let totalMinutes = 0;

  while (true) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    if (weekday !== 0 && weekday !== 6) {
      const windowStart = localWallTimeToUtc(
        year,
        month,
        day,
        BUSINESS_START,
        BUSINESS_TIMEZONE,
      );
      const windowEnd = localWallTimeToUtc(
        year,
        month,
        day,
        BUSINESS_END,
        BUSINESS_TIMEZONE,
      );
      const overlapStart = windowStart > start ? windowStart : start;
      const overlapEnd = windowEnd < end ? windowEnd : end;

      if (overlapEnd > overlapStart) {
        totalMinutes += (overlapEnd - overlapStart) / MS_PER_MINUTE;
      }
    }

    if (
      year === endParts.year &&
      month === endParts.month &&
      day === endParts.day
    ) {
      break;
    }

    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }

  return totalMinutes;
};

const formatBusinessDuration = (totalMinutes) => {
  const roundedMinutes = Math.round(totalMinutes);
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

// first_call_date_ad is a read-only rollup that can point to a call from
// years before a contact's *current* campaign engagement (e.g. a contact
// called once in 2021 who re-engages via a new campaign in 2024) — for
// contacts where that rollup can't possibly reflect this engagement (missing,
// or on/before the Lead Import date), look up their real call activity
// instead and use the earliest call that actually happened after Lead Import
const resolveFirstCallDates = async (contacts) => {
  const needsLookup = contacts.filter((contact) => {
    const firstCallDate = contact.properties.first_call_date_ad;
    const leadImportDate = getEngagementDate(contact);
    return (
      !firstCallDate || new Date(firstCallDate) <= new Date(leadImportDate)
    );
  });

  if (needsLookup.length === 0) return;

  const callIdsByContactId = await fetchCallAssociations(
    needsLookup.map((contact) => contact.id),
  );

  const allCallIds = [...callIdsByContactId.values()].flat();
  const timestampByCallId = await fetchCallsByIds(allCallIds);

  for (const contact of needsLookup) {
    const leadImportDate = getEngagementDate(contact);
    const callIds = callIdsByContactId.get(contact.id) ?? [];

    const qualifyingTimestamps = callIds
      .map((callId) => timestampByCallId.get(callId))
      .filter(
        (timestamp) =>
          timestamp && new Date(timestamp) > new Date(leadImportDate),
      );

    if (qualifyingTimestamps.length > 0) {
      contact.resolvedFirstCallDate = qualifyingTimestamps.reduce(
        (earliest, timestamp) =>
          new Date(timestamp) < new Date(earliest) ? timestamp : earliest,
      );
    }
  }
};

// returns undefined (rather than a string) when either date is missing, so
// the caller can omit the property from the update instead of clearing it
const getTimeToFirstContactAd = (contact) => {
  const leadImportDate = getEngagementDate(contact);
  const firstCallDate =
    contact.resolvedFirstCallDate ?? contact.properties.first_call_date_ad;

  if (!leadImportDate || !firstCallDate) return undefined;

  return formatBusinessDuration(
    businessMinutesBetween(leadImportDate, firstCallDate),
  );
};

const updateContactsBatch = async (contacts) => {
  for (const batch of chunk(contacts, 100)) {
    await axios.post(
      `https://api.hubapi.com/crm/v3/objects/contacts/batch/update`,
      {
        inputs: batch.map((contact) => ({
          id: contact.id,
          properties: {
            lead_campaign_engagement_date: getEngagementDate(contact),
            // document_downloadedad_booked: contact.segment,
            lead_source__ad: getLeadSourceAd(contact),
            time_to_first_contact_ad: getTimeToFirstContactAd(contact),
          },
        })),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    console.log(`Updated batch of ${batch.length} contacts`);
  }
};

const SEGMENTS = [
  {
    segment: "3 Overlooked Tax Strategies for Portfolios over $1 Million",
    id: 77229,
    channel: "MacDev",
  },
  {
    segment: "Get Your Complimentary Financial Planning Session - Booking",
    id: 68442,
    channel: "MacDev",
  },
  {
    segment: "4 Proven Investment Strategies to see through your Retirement",
    id: 68594,
    channel: "MacDev",
  },
  {
    segment: "7 Overlooked Tax Strategies Every Canadian Should Understand",
    id: 68593,
    channel: "MacDev",
  },
  {
    segment: "Streamline Your Practice - PDF",
    id: 73575,
    channel: "CorpDev",
  },
  {
    segment: "Growth Your Practice - PDF",
    id: 68595,
    channel: "CorpDev",
  },
  {
    segment: "3 Streamlining Strategies for Books over $100 Million",
    id: 77170,
    channel: "CorpDev",
  },
  {
    segment: "3 Mistakes to Avoid Making When Selling Yoursh Book",
    id: 77168,
    channel: "CorpDev",
  },
  {
    segment: "Book Your Confidential Dealer Assessment Today - Booking",
    id: 68446,
    channel: "CorpDev",
  },
  {
    segment: "3 Mistakes to Avoid When Planning Your Next Work Party",
    id: 77179,
    channel: "House of McGrath",
  },
  {
    segment: "(House of McGrath) - Inquiry",
    id: 77186,
    channel: "House of McGrath",
  },
  {
    segment: "3 Mistakes to Avoid When Renewing Your Office Lease",
    id: 76962,
    channel: "McGrath",
  },
  {
    segment: "3 Musts When Choosing Your Shared Office Space Location",
    id: 77041,
    channel: "McGrath",
  },
  {
    segment: "Tour Our Premium Heritage Office Suites This Week - Booking",
    id: 68447,
    channel: "McGrath",
  },
  {
    segment: "Tour Our Premium Heritage Office Suites This Week - Booking",
    id: 77739,
    channel: "McGrath",
  },
  {
    segment: "Tour Our Premium Heritage Office Suites This Week - Booking",
    id: 77736,
    channel: "McGrath",
  },
  {
    segment: "Shared Office Space for as low as $99/Month - Booking",
    id: 77740,
    channel: "McGrath",
  },
  {
    segment: "Shared Office Space for as low as $99/Month - Booking",
    id: 77738,
    channel: "McGrath",
  },
  {
    segment: "Shared Office Space for as low as $99/Month - Booking",
    id: 77737,
    channel: "McGrath",
  },
];

// implement the init fn below
const init = async (segments) => {
  const contacts = await fetchAllSegmentContacts(segments);
  await resolveFirstCallDates(contacts);
  console.log(`updating ${contacts.length} contacts`);
  await updateContactsBatch(contacts);
};

module.exports = { init, SEGMENTS };

if (require.main === module) init(SEGMENTS);
