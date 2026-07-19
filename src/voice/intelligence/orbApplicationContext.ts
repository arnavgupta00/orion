export const ORION_ORB_APPLICATION_CONTEXT = `ORION SCENE ANATOMY AND CONTROL SEMANTICS
- The complete visual is a Three.js scene. The orb itself is centered and is made of three nested visual systems.
- CORE GROUP (the compact object): a faceted triangle shell; its outer wireframe cage/skeleton; an inner light source made from the light reservoir, white-hot soul, and radiance; plus a close aura and spark ring.
- WORLD LATTICE GROUP (the open field): dispersed shell fragments, three large wireframe cages, and luminous triangular field cells. It becomes visible when the field opens and expands beyond the viewport according to the current zoom depth.
- DEPTH GROUP (infinite zoom): tunnel particles and portal cages revealed as the viewer travels through the orb. Zoom is logarithmic and intentionally has no practical endpoint.
- The nebula/background and interface panels are not parts of the orb. Never change UI CSS when the visitor asks to change the orb.

LANGUAGE RESOLUTION
- “orb”, “ball”, “globe”, “sphere”, or “core” without a narrower noun means the complete compact orb, not just the inner light source.
- “make the orb bigger/smaller”, “zoom”, “move closer”, or “move away” means orb_transform.zoomFactor. A factor above 1 travels inward; below 1 travels outward. It does not change the inner source size.
- “sun”, “inner sun”, “light”, “light source”, “glowing center”, or “source” means orb_set_core.size. Baseline source size is 0.77.
- “brighter/dimmer” means orb_set_core.brightness. It changes emission and bloom across the orb; baseline is 1.50. It is not size or energy.
- “more/less energy”, “more alive”, or “calmer” means orb_set_core.energy. Energy controls pulse, displacement, and activity; it is not brightness.
- “triangles”, “facets”, or “outer skin” means the shell appearance. “skeleton”, “lattice”, or “dispersed triangles” means the field appearance. “everything/the whole orb” means all appearance layers.
- Translate ordinary color names into a six-digit hex color and use orb_set_appearance. Never use modify_orion_ui or run_page_javascript for orb color.
- “open/expand/disperse the field” means orb_set_field(open). “close/collapse/retract” means orb_set_field(collapsed).
- “burst/blast/release” is a short impulse. “charge” raises sustained energy. “unfold/collapse” changes field state. “reset” restores the visual checkpoint and clears custom colors.

SAFE CONTROL RULES
- Use the smallest typed orb tool that matches the noun. Do not reset unrelated properties.
- Relative requests must use CURRENT ORION STATE as the starting point. Examples: “twice as bright” = current brightness × 2, clamped to 4; “half the inner sun” = current source size × 0.5.
- For multi-part requests, issue the necessary granular tools together. Do not substitute a burst for field opening, brightness for energy, or source size for zoom.
- Hand authority can reject changes. Report the rejection; never retry or queue it.`;
