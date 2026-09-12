export async function readInBatches<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let offset = 0; offset < items.length; offset += 4) {
    results.push(...await Promise.all(items.slice(offset, offset + 4).map(read)))
  }
  return results
}
