import crypto from 'crypto'

function md5(input) {
  return crypto.createHash('md5').update(input).digest('hex')
}

// Robokassa initial-payment signature: MD5(MerchantLogin:OutSum:InvId:Password1)
export function buildPaymentUrl({ outSum, invId, description }) {
  const merchantLogin = process.env.MERCHANT_LOGIN
  const password1 = process.env.ROBOKASSA_PASSWORD1
  const isTest = process.env.ROBOKASSA_TEST === '1'

  const signature = md5(`${merchantLogin}:${outSum}:${invId}:${password1}`)

  const params = new URLSearchParams({
    MerchantLogin: merchantLogin,
    OutSum: String(outSum),
    InvId: String(invId),
    Description: description,
    SignatureValue: signature,
  })
  if (isTest) params.set('IsTest', '1')

  return `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}`
}

// Robokassa ResultURL (webhook) signature: MD5(OutSum:InvId:Password2)
// NOTE: Password2, not Password1 — mixing these up is the classic mistake.
export function verifyResultSignature({ outSum, invId, signatureValue }) {
  const password2 = process.env.ROBOKASSA_PASSWORD2
  const expected = md5(`${outSum}:${invId}:${password2}`)
  return expected.toLowerCase() === String(signatureValue).toLowerCase()
}
