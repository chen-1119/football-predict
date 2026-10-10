# Restore the retained 2026-10-10 reviewed combinations

This change restores the three two-leg groups from an actual production center
observation at `2026-10-10T12:17:26.709Z`. It does not create new recommendations.
The original view was published at `2026-10-10T12:16:39.396Z` and contained 27
reviewed singles and the three group products `2.5026`, `5.035`, and `10.011`.

The retained response SHA-256 is
`f5f085f915f8441ada6e6c6d2fb4bedcf1eb1c9966639a43b440757bbeeed324`.
The extracted original view keeps its original seal and clocks. Its JSON SHA-256
is `a3b6c9caadbe3b3d06c393adec8e573ca1c21d2891baf23817208811694c1d2b`.

The installed reader first verifies the stored singles and their commit ACKs in
the existing read-only transaction. The archive must match those records and
their publication identity, and each original leg must have the same event,
market, handicap, direction, and SP. The original observation must precede every
leg's cutoff. Product arithmetic validates the retained numbers only.

The archive is displayed separately as historical content. It never authorizes
a current pick or settlement, replaces a frozen record, or supplies a past clock
to the publisher. No original three-leg groups were present in this observation.
Visible confidence labels stay removed.
