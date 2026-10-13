module NegNativeClobber {
  import nativeTxn(BUG = "clobber-recreation", KIND = "replace", INTERFERENCE = true).* from "../nativeTxn"
}
