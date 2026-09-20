// @fpv/catalog: Products, textures, libraries, verification, BOM rules (spec 02, 07).
// This entry is pure (no Node-only APIs) so commands and the web app can import the schemas;
// the SQLite store and on-disk installation live behind "@fpv/catalog/store".
export const PACKAGE = "catalog" as const;
export { effectiveCutOutPath, isValidCutOutPath } from "./cutout.js";
export { cutOutRings, cutOutTolerance, type UnitPoint } from "./cutout-rings.js";
export {
  type FlatImportOptions,
  type FlatImportResult,
  type ImportedPiece,
  type ImportedTexture,
  importFlatCatalog,
  importFlatTextures,
  parseCreationDate,
  parseProperties,
  resolveReference,
} from "./flat.js";
export { productMaterialSlots, type SlotSource } from "./materials.js";
export { IDENTITY, normaliseMeshRotation, parseMatrix, snapMatrix } from "./matrix.js";
export { AV_CORE, AV_CORE_INPUT } from "./rules/av-core.js";
export {
  BOM_CSV_COLUMNS,
  Bom,
  BomLine,
  type BomOptions,
  type BomScope,
  BomStatus,
  BomUnit,
  bomToCsv,
  getBom,
  parseBomScope,
} from "./rules/bom.js";
export { checkDesign } from "./rules/design.js";
export {
  checkSyntax,
  type EvalResult,
  ExprError,
  evalCondition,
  evalNumber,
  evaluate,
  Handle,
  type Node as ExprNode,
  parse as parseExpr,
  type Scope as ExprScope,
  type Value as ExprValue,
} from "./rules/expr.js";
export {
  type BomCatalog,
  cableRun,
  clearanceBehind,
  doorZone,
  type ItemFacts,
  itemsInDoorSwing,
  makeScope,
  type PriceInfo,
  type ProductInfo,
  ProjectFacts,
  productInfo,
  recipeKey,
} from "./rules/facts.js";
export { CORE_RULES, HOME_CORE, HOME_CORE_INPUT } from "./rules/home-core.js";
export { checkLayout, HOME_PURPOSES, type LayoutReport, layoutIsBuildable } from "./rules/layout.js";
export {
  corridorFor,
  isResidential,
  MIN_SIDE,
  missingFromProgramme,
  type PackResult,
  type Programme,
  type ProgrammeRoom,
  packProgramme,
} from "./rules/pack.js";
export {
  type LayoutQuality,
  layoutQuality,
  MAX_ASPECT,
  type QualityContext,
  type Sliver,
} from "./rules/quality.js";
export {
  BomRule,
  DependencyRule,
  DesignRule,
  DistanceRule,
  mergePacks,
  type PackProblem,
  RoomRecipe,
  RulesPack,
  type RulesPackInput,
  ScopeRule,
  validatePack,
} from "./rules/schema.js";
export {
  CATEGORIES,
  Category,
  DegSigned,
  Embed,
  isOpeningCategory,
  LibraryManifest,
  type LibraryManifestInput,
  MountPoint,
  OpeningSpec,
  Price,
  Product,
  type ProductInput,
  ProductSlug,
  ProductSnapshot,
  REQUIRED_SPECS,
  Sash,
  SpecValue,
  snapshotOf,
  Texture,
  type TextureInput,
  TextureSnapshot,
  Verification,
  VerificationStatus,
} from "./schema.js";
export {
  decodeCursor,
  encodeCursor,
  expandTokens,
  ftsQuery,
  modelKey,
  normaliseText,
  SEARCH_LIMIT,
  SYNONYMS,
  slug,
  tokens,
} from "./search.js";
export { SEED_PRODUCTS } from "./seed/products.js";
export {
  ensureSeed,
  GENERATED_LIBRARY,
  GENERATED_LIBRARY_ID,
  GENERATED_VERSION,
  SEED_LIBRARY,
  SEED_LIBRARY_ID,
  SEED_VERSION,
  type SeedTarget,
} from "./seed.js";
export { type CatalogProblem, DISPLAY_MAX_DEPTH_MM, hasErrors, validateProduct } from "./validate.js";
export {
  canonicalMake,
  hostOf,
  isManufacturerUrl,
  MAKES,
  type MakeRecord,
  makeDomains,
} from "./verify/makes.js";
export {
  DEFAULT_MAX_PAGES,
  type ExtractInput,
  PRICE_TTL_DAYS,
  type ProposalExtractor,
  rankHits,
  type VerificationRun,
  type VerifyDeps,
  VerifyInputError,
  type VerifyOutcome,
  type VerifyRequest,
  type VerifyStatus,
  type VerifyStore,
  VerifyUnavailable,
  verifyProduct,
} from "./verify/pipeline.js";
export {
  PRODUCT_PROPOSAL_JSON_SCHEMA,
  ProductProposal,
  type ProductProposalInput,
} from "./verify/proposal.js";
export {
  DIMS_WINDOW,
  dimsStated,
  dimsStatedCount,
  type EvidencePage,
  plausibility,
  type Score,
  scoreProposal,
  specStated,
  VERIFIED_THRESHOLD,
  type VerificationChecks,
  WEIGHTS,
} from "./verify/score.js";
export {
  alnum,
  findQuantity,
  GROUNDING_TOLERANCE,
  htmlToText,
  mentionsModel,
  type Quantity,
  quantities,
  relevantExcerpt,
  within,
} from "./verify/text.js";
export {
  braveSearch,
  type FetchedPage,
  type FetchFn,
  type PageFetcher,
  SearchError,
  type SearchHit,
  type SearchProvider,
  searxngSearch,
  staticFetcher,
  staticSearch,
} from "./verify/web.js";
