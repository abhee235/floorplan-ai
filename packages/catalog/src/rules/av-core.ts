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
    // The numbers the office recipes are built on (ADR-026 D1: numbers go to the pack). A desk is
    // 1600 x 800; a bench aisle is 1,500 so two people pass; a cafeteria seat is 1.3 m² of floor
    // and a meeting seat about 2.
    deskWidthMm: 1600,
    deskDepthMm: 800,
    benchAisleMm: 1500,
    cafeteriaM2PerSeat: 1.3,
    meetingM2PerSeat: 2,
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
    // The four below are what a real run asked for by name and was refused (ADR-027 D7). A pack
    // with huddle, boardroom and training furnished a six-seat meeting room as a boardroom, a
    // cafeteria as one dinner table for twelve, a reception with nothing, and a hundred desks as
    // two grids laid over each other.
    {
      // A meeting room is a boardroom that is not trying to impress anybody: the same table,
      // chairs, display and bar, at the clearance a working room needs, for the four-to-twelve-seat
      // rooms an office has most of.
      id: "meeting",
      purpose: "meeting",
      capacityRange: [4, 12],
      steps: [
        { op: "table", shape: "rect", seatsExpr: "room.capacity", clearanceMm: 900 },
        { op: "chairs", around: "table", pitchMm: 700 },
        {
          op: "display",
          wall: "auto",
          diagonalExpr: "max(65, ceil(seatDistanceMm / 25.4 / viewerRatioDetail))",
          centreHeightMm: 1400,
          countExpr: "1",
        },
        { op: "video-bar", under: "display" },
        { op: "by-door", category: "scheduler", heightMm: 1400, side: "inside" },
      ],
      productPreferences: [
        { category: "table", constraint: "seats >= neededSeats and shape == 'rect'", preferMake: [] },
        { category: "display", constraint: "diagonalIn >= neededDiagonalIn", preferMake: [] },
        { category: "video-bar", constraint: "maxRoomDepthMm >= seatDistanceMm", preferMake: [] },
      ],
    },
    {
      // Benches of six: three desks in a row, three more back to back with them, a chair on the
      // outside of each, and an aisle a person can pass another in between one bench and the next.
      // Every desk gets its chair from the same step, which is the whole difference between this
      // and the two grids.
      id: "open-office",
      purpose: "open-office",
      capacityRange: [4, 400],
      steps: [
        {
          op: "arrange",
          pattern: "bench",
          category: "desk",
          countExpr: "room.capacity",
          spacingMm: 1500,
          seatsEach: 1,
          sides: 1,
          perCluster: 3,
          aisleMm: 1500,
        },
      ],
      productPreferences: [
        { category: "desk", constraint: "w >= 1400 and w <= 1800 and d >= 700 and d <= 900", preferMake: [] },
      ],
    },
    {
      // Small tables with chairs on both sides, in rows with room to carry a tray between them: one
      // four-seat table for every four the room is said to hold.
      id: "cafeteria",
      purpose: "cafeteria",
      capacityRange: [4, 200],
      steps: [
        {
          op: "arrange",
          pattern: "rows",
          category: "table",
          countExpr: "ceil(room.capacity / 4)",
          spacingMm: 900,
          seatsEach: 2,
          sides: 2,
          perCluster: 0,
          aisleMm: 1500,
        },
      ],
      productPreferences: [
        { category: "table", constraint: "seats <= 4 and w <= 1400", preferMake: [] },
        { category: "chair", constraint: "w <= 500", preferMake: [] },
      ],
    },
    {
      // A desk with its back to the wall facing the door, and somewhere to wait along a wall beside
      // it. The "auto" wall is the one opposite the door, which is where a reception desk goes.
      id: "reception",
      purpose: "reception",
      capacityRange: [0, 40],
      steps: [
        {
          op: "along-wall",
          category: "desk",
          wall: "auto",
          countExpr: "1",
          where: null,
          shape: "box",
          sizeMm: { w: 2400, d: 800, h: 1100 },
          label: "Reception desk",
          spacingMm: 0,
          align: "centre",
          clearanceMm: 1200,
          beforeWindow: true,
        },
        {
          op: "along-wall",
          category: "sofa",
          wall: "beside-display",
          countExpr: "ceil(room.capacity / 4)",
          where: null,
          shape: "sofa",
          sizeMm: { w: 1800, d: 900, h: 850 },
          label: "Waiting sofa",
          spacingMm: 300,
          align: "start",
          clearanceMm: 900,
        },
      ],
      productPreferences: [{ category: "desk", constraint: "w >= 1800", preferMake: [] }],
    },
  ],
};

export const AV_CORE: RulesPack = RulesPack.parse(AV_CORE_INPUT);
