# Accepted bootstrap for the PostgreSQL-only cutover

The signed policy and recovery journal pin r730: a69f15cc7deeb44343cede093f2b6b0e8ea02b01587121b856c2f4d10f6e194b.
Its normal full deployment completed, the new runtime completed an official
worker cycle, and independent after-deployment checks preserved all original
198 decisions and evidence bindings. Frozen archive and public ledger
continuity passed. Model promotion remains disabled by its existing gates.

These are bootstrap proofs, not acceptance of the subsequent native release.
The native lane must still take its own fresh backup, verify the complete
mirror, pass retirement parity, switch, and complete live/public readiness.

Proof byte bindings:

- current-release-a69f15cc7deeb44343cede093f2b6b0e8ea02b01587121b856c2f4d10f6e194b-deploy-result.json: `b82777fd6a27204d04edb92e241e2167eb6fb6e7ee2746bda23879042f97fbfd`
- release-objects-r730-20260912-0522-comparison.json: `450f6a8d285d7117584876e3a15e0a88ab945f23b2b7948669662ae116527d3a`
- accepted-runtime-a69f15cc7deeb44343cede093f2b6b0e8ea02b01587121b856c2f4d10f6e194b.json: `819018b093b3c4cde4d3874daccf1bed37a8ee99369170fb49d5215ef8777b49`
- accepted-public-a69f15cc7deeb44343cede093f2b6b0e8ea02b01587121b856c2f4d10f6e194b.json: `3fbf5955728b7b2b0d159ab20a7450513792e5b4cb429c60703fb668a9624f75`
- original-repair-evidence-after-full-1789166189637.json: `274f60986cde642a0d353bd3e3214acd6667362ce818bf870f5871ebc674173a`
