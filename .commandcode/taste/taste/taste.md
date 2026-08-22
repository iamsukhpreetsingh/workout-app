# Taste
- Strongly prefers reusing existing codebase components, shared vocabularies, and established patterns verbatim — e.g., reusing an existing chip-selection component ("reuse it exactly, do not build a new one"), matching an existing allergen string vocabulary exactly instead of inventing a separate list, and following the same association-check / visual-treatment patterns already used by other endpoints and UI. Confidence: 0.95
- Prefers simple, explicit, deterministic logic (exact set-intersection, fixed value lists) over heuristic, keyword-matching, or "smart" auto-detection; explicitly does not want detection logic generalized beyond what was specified. Confidence: 0.9
- Wants the full specification read before starting implementation, because later phases depend on exact field names and data shapes defined in earlier phases. Confidence: 0.8
- Prefers multi-step forms with one focus area per screen, a progress indicator, and Back/Next navigation over a single giant scrolling form. Confidence: 0.8
- Prefers validating user input server-side against fixed allowed value lists, rejecting anything else with a clear error. Confidence: 0.7
- Prefers persisting partial form progress (at minimum locally) so users don't lose already-entered data if they close the app mid-form. Confidence: 0.7
