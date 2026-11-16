// The material slots a product can be finished in (spec 02 section 1). A product that brings its own model
// lists that model's slots; one that does not is drawn as its category's recipe (section 3.1), so it takes
// the recipe's slots, and a chair from the catalogue has a fabric and a frame like any other chair.
import { recipeForCategory } from "@fpv/assets";
import { derive } from "@fpv/ir";

export interface SlotSource {
  category?: string;
  materialSlots?: readonly string[];
}

export function productMaterialSlots(product: SlotSource): readonly string[] {
  if (product.materialSlots && product.materialSlots.length > 0) return product.materialSlots;
  return derive.recipeSlots(recipeForCategory(product.category ?? "other"));
}
