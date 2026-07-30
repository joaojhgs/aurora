import assert from 'node:assert/strict'

export const expectedRoleSwitchEvidence = Object.freeze({
  passed: true,
  from: 'remote-console',
  to: 'mesh-node',
})

export function assertRoleSwitchEvidence(evidence, label = 'report') {
  assert.equal(
    evidence?.passed,
    expectedRoleSwitchEvidence.passed,
    `${label} roleSwitchEvidence.passed must be true`,
  )
  assert.equal(
    evidence?.from,
    expectedRoleSwitchEvidence.from,
    `${label} roleSwitchEvidence.from must be remote-console`,
  )
  assert.equal(
    evidence?.to,
    expectedRoleSwitchEvidence.to,
    `${label} roleSwitchEvidence.to must be mesh-node`,
  )
}
