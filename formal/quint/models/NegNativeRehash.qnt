module NegNativeRehash {
  import nativeTxn(BUG = "skip-rehash", KIND = "replace", INTERFERENCE = true).* from "../nativeTxn"
}
