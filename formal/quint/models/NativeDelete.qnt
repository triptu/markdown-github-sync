module NativeDelete {
  import nativeTxn(BUG = "none", KIND = "delete", INTERFERENCE = true).* from "../nativeTxn"
}
