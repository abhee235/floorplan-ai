// The core AV rules pack (spec 07 section 3.1, ADR-009 D6): data, not code. Shipped with the product
// and overlaid by a user's own pack through mergePacks.
import { RulesPack, type RulesPackInput } from "./schema.js";

const MEETING = "('meeting', 'boardroom', 'huddle', 'training')";

export const AV_CORE_INPUT: RulesPackInput = {
  id: "av-core",
  version: "1.0.0",
  name: "AV core rules",
  extends: null,
  facts: {
    cableStockLengthsMm: [500, 1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000],
    cableSlackMm: 1000,
    seatsPerTablePowerModule: 4,
    commissioningHoursPerRoom: 4,
    viewerRatioDetail: 6,
    viewerRatioVideo: 4,
    micAreaM2: 20,
    speakerAreaM2: 25,
    chairClearanceMm: 900,
    displayCentreHeightMm: 1400,
    displayCentreToleranceMm: 150,
  },
  bomRules: [
    {
      kind: "dependency",
      id: "display-mount",
      per: "item",
      when: { category: "display", where: "item.mount == 'wall'" },
      add: {
        category: "mount",
        constraint: "has(vesa, spec('vesa')) and maxKg >= item.weightKg",
        description: "VESA wall mount",
      },
      quantity: "1",
      unit: "each",
      note: "one wall mount per wall-mounted display, matching its VESA pattern and weight",
    },
    {
      kind: "distance",
      id: "display-hdmi",
      when: { fromCategory: "display", toCategory: ["video-bar", "table"], sameRoom: true },
      add: {
        category: "cable",
        constraint: "type == 'HDMI' and lengthMm >= length",
        description: "HDMI cable {m} m",
      },
      length: "roundUpToAny(distance(from, to) + cableSlackMm, cableStockLengthsMm)",
      perPair: false,
    },
    {
      kind: "distance",
      id: "bar-usb",
      when: { fromCategory: "video-bar", toCategory: "table", sameRoom: true },
      add: {
        category: "cable",
        constraint: "type == 'USB' and lengthMm >= length",
        description: "USB cable {m} m",
      },
      length: "roundUpToAny(distance(from, to) + cableSlackMm, cableStockLengthsMm)",
      perPair: false,
    },
    {
      kind: "dependency",
      id: "speaker-amp",
      per: "room",
      when: { category: "ceiling-speaker", where: null },
      add: {
        category: "amplifier",
        constraint: "channels >= count('ceiling-speaker')",
        description: "Amplifier with a channel per ceiling speaker",
      },
      quantity: "1",
      unit: "each",
    },
    {
      kind: "dependency",
      id: "mic-dsp",
      per: "room",
      when: { category: "ceiling-mic", where: null },
      add: {
        category: "dsp",
        constraint: "inputs >= sum('ceiling-mic', 'channels')",
        description: "DSP with an input per ceiling microphone channel",
      },
      quantity: "1",
      unit: "each",
    },
    {
      kind: "scope",
      id: "network-ports",
      scope: "room",
      when: null,
      add: { category: "switch", description: "PoE switch port" },
      // devices placed in the room, PoE microphones, and the DSP that mic-dsp adds when there are ceiling mics
      quantity:
        "count('display') + count('video-bar') + count('touch-panel') + count('scheduler') + count('dsp') + countWhere('ceiling-mic', 'poe', '==', true) + if(count('ceiling-mic') > 0 and count('dsp') == 0, 1, 0)",
      unit: "each",
    },
    {
      kind: "scope",
      id: "scheduler",
      scope: "room",
      when: `room.purpose in ${MEETING} and room.capacity >= 4 and count('scheduler') == 0`,
      add: { category: "scheduler", constraint: "true", description: "Room scheduling panel by the door" },
      quantity: "1",
      unit: "each",
    },
    {
      kind: "scope",
      id: "table-power",
      scope: "room",
      when: "count('table') > 0 and room.capacity > 0",
      add: {
        category: "connector",
        constraint: "kind == 'table-power'",
        description: "Table power and data module",
      },
      quantity: "ceil(room.capacity / seatsPerTablePowerModule)",
      unit: "each",
    },
    {
      kind: "scope",
      id: "commissioning",
      enabled: false,
      scope: "room",
      when: "count('display') > 0",
      add: { category: "other", description: "Commissioning and testing" },
      quantity: "commissioningHoursPerRoom",
      unit: "hour",
      labour: true,
    },
  ],
  designRules: [
    {
      id: "display-size-detail",
      applies: `room.purpose in ${MEETING} and count('display') > 0 and count('chair') > 0`,
      check: "max('display', 'diagonalIn') * 25.4 * viewerRatioDetail >= farthest('display', 'chair')",
      message:
        "the largest display is too small for the farthest seat; its diagonal should be at least a sixth of the viewing distance",
      hint: "use a larger display or bring the seating closer",
    },
    {
      id: "display-size-video",
      enabled: false,
      applies: `room.purpose in ${MEETING} and count('display') > 0 and count('chair') > 0`,
      check: "max('display', 'diagonalIn') * 25.4 * viewerRatioVideo >= farthest('display', 'chair')",
      message:
        "for video-first rooms the display diagonal should be at least a quarter of the farthest viewing distance",
      hint: "use a larger display",
    },
    {
      id: "camera-fov",
      applies: "count('video-bar') > 0 and count('table') > 0 and count('chair') > 0",
      check:
        "2 * farthest('video-bar', 'chair') * tan(max('video-bar', 'fovDeg') / 2) >= min('table', 'd') + 2 * max('chair', 'd')",
      message: "the camera's field of view does not cover the table and its chairs at the farthest seat",
      hint: "use a wider camera or move it further from the table",
    },
    {
      id: "ceiling-mic-coverage",
      applies: `room.purpose in ${MEETING} and room.areaM2 > micAreaM2`,
      check: "count('ceiling-mic') + count('table-mic') >= ceil(room.areaM2 / micAreaM2)",
      message: "one ceiling or table microphone is needed per 20 m²",
      hint: "add ceiling microphones spread over the seating",
    },
    {
      id: "ceiling-speaker-coverage",
      applies: `room.purpose in ${MEETING} and room.areaM2 > speakerAreaM2`,
      check: "count('ceiling-speaker') + count('soundbar') >= ceil(room.areaM2 / speakerAreaM2)",
      message: "one ceiling speaker is needed per 25 m²",
      hint: "add ceiling speakers spread over the room",
    },
    {
      id: "chair-clearance",
      applies: "count('chair') > 0",
      check: "clearanceBehind('chair') >= chairClearanceMm",
      message: "a chair has less than 900 mm free behind it",
      hint: "move the table or chairs away from the wall or furniture behind them",
    },
    {
      id: "door-swing-clear",
      applies: "true",
      check: "doorSwingBlocked() == 0",
      message: "furniture stands in a door's swing area",
      hint: "keep a square as wide as the door clear inside the room",
    },
    {
      id: "display-centre-height",
      applies: `room.purpose in ${MEETING} and countWhere('display', 'mount', '==', 'wall') > 0`,
      check:
        "abs(max('display', 'centreHeight') - displayCentreHeightMm) <= displayCentreToleranceMm and abs(min('display', 'centreHeight') - displayCentreHeightMm) <= displayCentreToleranceMm",
      message: "wall displays in seated rooms should be centred about 1400 mm above the floor",
      hint: "set the display elevation so its centre is near 1400 mm",
    },
  ],
  // Room recipes (spec 07 section 4). Expressions see room.capacity, room.areaM2, room.widthMm (across the
  // display wall), room.depthMm (away from it), the pack facts, and while choosing products: seats,
  // diagonal and seatDistanceMm (farthest seat from the display wall centre), plus the candidate's specs.
  recipes: [
    {
      id: "huddle",
      purpose: "huddle",
      capacityRange: [2, 5],
      steps: [
        { op: "table", shape: "round", seatsExpr: "room.capacity", clearanceMm: 600 },
        { op: "chairs", around: "table", pitchMm: 700 },
        {
          op: "display",
          wall: "auto",
          diagonalExpr: "max(55, ceil(seatDistanceMm / 25.4 / viewerRatioDetail))",
          centreHeightMm: 1400,
          countExpr: "1",
        },
        { op: "video-bar", under: "display" },
        { op: "by-door", category: "scheduler", heightMm: 1400, side: "inside" },
      ],
      productPreferences: [
        { category: "table", constraint: "seats >= neededSeats and shape == 'round'", preferMake: [] },
        { category: "display", constraint: "diagonalIn >= neededDiagonalIn", preferMake: [] },
        { category: "video-bar", constraint: "maxRoomDepthMm >= seatDistanceMm", preferMake: [] },
      ],
    },
    {
      id: "boardroom",
      purpose: "boardroom",
      capacityRange: [6, 20],
      steps: [
        { op: "table", shape: "rect", seatsExpr: "room.capacity", clearanceMm: 1000 },
        { op: "chairs", around: "table", pitchMm: 720 },
        {
          op: "display",
          wall: "auto",
          diagonalExpr: "max(75, ceil(seatDistanceMm / 25.4 / viewerRatioDetail))",
          centreHeightMm: 1400,
          countExpr: "1",
        },
        { op: "video-bar", under: "display" },
        { op: "ceiling-array", category: "ceiling-mic", perAreaM2: 20, minCount: 1 },
        { op: "ceiling-array", category: "ceiling-speaker", perAreaM2: 25, minCount: 2 },
        { op: "by-door", category: "scheduler", heightMm: 1400, side: "inside" },
      ],
      productPreferences: [
        { category: "table", constraint: "seats >= neededSeats and shape == 'rect'", preferMake: [] },
        { category: "display", constraint: "diagonalIn >= neededDiagonalIn", preferMake: [] },
        { category: "video-bar", constraint: "maxRoomDepthMm >= seatDistanceMm", preferMake: [] },
      ],
    },
    {
      id: "training",
      purpose: "training",
      capacityRange: [21, 60],
      steps: [
        {
          op: "arrange",
          pattern: "rows",
          category: "table",
          countExpr: "ceil(room.capacity / 2)",
          spacingMm: 900,
          seatsEach: 2,
        },
        {
          op: "display",
          wall: "auto",
          diagonalExpr: "max(85, ceil(seatDistanceMm / 25.4 / viewerRatioDetail))",
          centreHeightMm: 1500,
          countExpr: "1",
        },
        { op: "video-bar", under: "display" },
        { op: "ceiling-array", category: "ceiling-mic", perAreaM2: 20, minCount: 1 },
        { op: "ceiling-array", category: "ceiling-speaker", perAreaM2: 25, minCount: 2 },
        { op: "by-door", category: "scheduler", heightMm: 1400, side: "inside" },
      ],
      productPreferences: [
        { category: "table", constraint: "seats <= 2 and w <= 1800", preferMake: [] },
        { category: "display", constraint: "diagonalIn >= neededDiagonalIn", preferMake: [] },
        { category: "video-bar", constraint: "maxRoomDepthMm >= seatDistanceMm", preferMake: [] },
      ],
    },
  ],
};

export const AV_CORE: RulesPack = RulesPack.parse(AV_CORE_INPUT);
