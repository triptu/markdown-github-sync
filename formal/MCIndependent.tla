---------------------------- MODULE MCIndependent ----------------------------
(* Wrapper so the Independent.cfg can bind Owner to a map that names the     *)
(* model values d1, d2, f1, f2.                                              *)
EXTENDS VaultSync
CONSTANTS d1, d2, f1, f2
DisjointOwner == (d1 :> {f1}) @@ (d2 :> {f2})
=============================================================================
