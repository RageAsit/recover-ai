const rupeeFormat = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
})

export function formatRupees(paise) {
  return rupeeFormat.format(paise / 100)
}
