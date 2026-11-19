// Unit conversions for the weather widget.

/** Kilometres per hour to metres per second. */
export function kmhToMs(kmh) {
  return kmh / 3.6
}

/** Degrees Celsius to degrees Fahrenheit. */
export function celsiusToFahrenheit(celsius) {
  return (celsius * 9) / 5 + 32
}
