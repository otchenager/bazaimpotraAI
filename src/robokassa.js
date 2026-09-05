import crypto from 'crypto'

function md5(input) {
  return crypto.createHash('md5').update(input).digest('hex')
}

// Robokassa initial-payment signature: MD5(MerchantLogin:OutSum:InvId:Password1)
// NOTE: in test mode (IsTest=1) Robokassa validates against the separate
// test Password #1/#2 pair from the merchant's technical settings, not the
// production passwords — using the production password here with IsTest=1
// produces error 29 even though the formula and MerchantLogin are correct.
export function buildPaymentUrl({ outSum, invId, description }) {
  const merchantLogin = process.env.MERCHANT_LOGIN
  const isTest = process.env.ROBOKASSA_TEST === '1'
  const password1 = isTest
    ? process.env.ROBOKASSA_TEST_PASSWORD1
    : process.env.ROBOKASSA_PASSWORD1

  const outSumStr = String(outSum)
  const invIdStr = String(invId)
  const signature = md5(`${merchantLogin}:${outSumStr}:${invIdStr}:${password1}`)

  const params = new URLSearchParams({
    MerchantLogin: merchantLogin,
    OutSum: outSumStr,
    InvId: invIdStr,
    Description: description,
    SignatureValue: signature,
  })
  if (isTest) params.set('IsTest', '1')

  return `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}`
}

// Robokassa ResultURL (webhook) signature: MD5(OutSum:InvId:Password2)
// NOTE: Password2, not Password1 — mixing these up is the classic mistake.
// isTest mirrors what Robokassa sends back in the IsTest field of the
// webhook body — test payments are signed with the test Password #2.
export function verifyResultSignature({ outSum, invId, signatureValue, isTest = false }) {
  const password2 = isTest
    ? process.env.ROBOKASSA_TEST_PASSWORD2
    : process.env.ROBOKASSA_PASSWORD2
  const expected = md5(`${outSum}:${invId}:${password2}`)
  return expected.toLowerCase() === String(signatureValue).toLowerCase()
}
